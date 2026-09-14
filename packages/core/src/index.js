'use strict';

/**
 * 酷狗音乐音源核心 —— 桌面端与手机端共用的统一门面
 *
 * 设计要点：
 *  1. 不跑本地服务器。原项目 KuGouMusicApi 是 Express 服务，直接调用接口
 *     在手机端不可行（没法塞一个 Node 服务进 APK）。这里把它的模块直接
 *     内联调用，两端共用同一份逻辑。
 *  2. 门面只做三件事：维护设备身份、维护登录会话、拼装调用参数。
 *     具体接口实现全部在 vendor/module/ 下保持原样，方便日后跟上游同步。
 *  3. 所有方法返回原项目的统一响应结构 { status, body, cookie, headers }，
 *     业务字段在 body 里。
 */

// React Native 里 process.env 不一定存在，但 vendor 的模块会读 process.env.platform。
// 标准版（非概念版 lite）走 platform 为空的分支，也就是我们要的 appid 1005 / clientver 20489。
if (typeof process === 'undefined') {
  // eslint-disable-next-line no-undef
  globalThis.process = { env: {} };
} else if (!process.env) {
  process.env = {};
}

const modules = require('./modules');
const { normalizeDeviceIdentity } = require('./device');
const { parseCookieString, cookieToJson, decodeLyrics } = require('./kugou/vendor/util/util');
const { createRequest } = require('./kugou/vendor/util/request');
const webApi = require('./web-api');

/** 需要写回本地持久化的会话字段 */
const SESSION_KEYS = ['token', 'userid', 'dfid', 'nickname', 'vip_type', 'pic'];

/**
 * 从任意嵌套结构里扒出所有 http(s) 地址
 *
 * 酷狗返回的 `url` 字段**不是字符串**：它可能是数组，也可能是嵌套对象，
 * `backupUrl` 同理。直接当字符串用会踩坑（实测会得到 "url 类型=object"）。
 *
 * @param {*} value
 * @param {string[]} [out]
 * @returns {string[]}
 */
function collectUrls(value, out = []) {
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectUrls(item, out);
    return out;
  }
  return out;
}

/**
 * 把 song_url 的原始响应规整成播放器好用的形状
 * @param {*} body song_url 的响应体（可能是对象或数组）
 * @returns {{url: string|null, backupUrls: string[], extName: string|null,
 *            fileSize: number, durationMs: number, restricted: boolean, failProcess: string[]}}
 */
function normalizeSongUrl(body) {
  const item = Array.isArray(body) ? body[0] : body;

  if (!item || typeof item !== 'object') {
    return { url: null, backupUrls: [], extName: null, fileSize: 0, durationMs: 0, restricted: false, failProcess: [] };
  }

  // 授权受限的响应长这样：没有可用地址，但带 fail_process / priv_status
  const failProcess = Array.isArray(item.fail_process)
    ? item.fail_process
    : item.fail_process
      ? [String(item.fail_process)]
      : [];

  const primary = collectUrls(item.url, []);
  const backups = collectUrls(item.backupUrl, []);

  return {
    url: primary[0] || backups[0] || null,
    backupUrls: backups,
    extName: item.extName || null,
    fileSize: Number(item.fileSize) || 0,
    durationMs: Number(item.timeLength) || 0,
    // 平台侧限制（需要购买 / 需要会员），不是程序错误
    restricted: primary.length === 0 && backups.length === 0 && (failProcess.length > 0 || item.priv_status !== undefined),
    failProcess,
  };
}

class KuGouClient {
  /**
   * @param {object} [options]
   * @param {Record<string,string>} [options.device]  上次持久化的设备身份
   * @param {Record<string,string>} [options.session] 上次持久化的登录会话
   * @param {(session: Record<string,string>) => void} [options.onSessionChange]
   *        会话发生变化（如拿到 token）时回调，调用方负责落盘
   */
  constructor(options = {}) {
    this.device = normalizeDeviceIdentity(options.device);
    this.session = Object.assign({}, options.session);
    this.onSessionChange = options.onSessionChange || null;
  }

  /** 是否已登录 */
  get isLoggedIn() {
    return Boolean(this.session.token && this.session.userid);
  }

  /** 服务端回传的 Set-Cookie 里挑出登录态相关字段并合并 */
  _absorbCookies(cookieList) {
    if (!Array.isArray(cookieList) || cookieList.length === 0) return;

    let changed = false;
    for (const raw of cookieList) {
      if (typeof raw !== 'string') continue;
      const parsed = cookieToJson(parseCookieString(raw));
      for (const key of Object.keys(parsed)) {
        const value = parsed[key];
        if (value === undefined || value === null || value === '') continue;
        if (this.session[key] !== value) {
          this.session[key] = value;
          changed = true;
        }
      }
    }

    if (changed && this.onSessionChange) this.onSessionChange(this.session);
  }

  /**
   * 通用接口调用
   *
   * vendor 下的模块签名统一是 (params, useAxios)：
   *  - params 里除了业务参数，还必须带 cookie（设备身份 + 登录态）
   *  - 模块可以自行传 cookie 覆盖，所以在 useAxios 这层再做一次兜底合并
   *
   * @param {string} name    modules.js 里注册的模块名，如 'song_url'
   * @param {object} [params] 业务参数
   */
  async call(name, params = {}) {
    const mod = modules[name];
    if (typeof mod !== 'function') {
      throw new Error(`接口模块未注册: ${name}（需要在 packages/core/src/modules.js 中登记）`);
    }

    const identity = Object.assign({}, this.device, this.session);

    const useAxios = (config = {}) =>
      createRequest(
        Object.assign({}, config, {
          cookie: Object.assign({}, identity, config.cookie || {}),
        })
      );

    const res = await mod(Object.assign({}, params, { cookie: identity }), useAxios);
    this._absorbCookies(res && res.cookie);
    return res;
  }

  /** 导出可持久化的状态（设备身份 + 会话） */
  toJSON() {
    return { device: this.device, session: this.session };
  }

  // ==========================================================
  // 设备 / 登录
  // ==========================================================

  /**
   * 注册设备，拿到酷狗下发的真实 dfid。
   * 建议首次启动时调一次，能明显降低后续被风控的概率。
   */
  async registerDevice() {
    const res = await this.call('register_dev');
    return res;
  }

  /** 第一步：取二维码 key */
  async loginQrKey(type) {
    return this.call('login_qr_key', { type });
  }

  /** 第二步：用 key 生成二维码（qrimg=true 时额外返回 base64 图片） */
  async loginQrCreate(key, qrImg = true) {
    return this.call('login_qr_create', { key, qrimg: qrImg });
  }

  /**
   * 第三步：轮询扫码状态
   * body.data.status: 0 过期 / 1 等待扫码 / 2 待确认 / 4 授权成功
   * status 为 4 时，token 和 userid 会写进 session
   */
  async loginQrCheck(key) {
    return this.call('login_qr_check', { key });
  }

  /** 手机号 + 验证码 / 密码登录 */
  async loginCellphone({ mobile, code, password, countryCode = '86', ...extra }) {
    return this.call('login_cellphone', {
      mobile,
      code,
      password,
      countrycode: countryCode,
      ...extra,
    });
  }

  /** 用已有 token 恢复登录态 */
  async loginToken() {
    return this.call('login_token');
  }

  /** 退出登录：清空本地会话，并通知调用方落盘 */
  logout() {
    this.session = { dfid: this.device.dfid };
    if (this.onSessionChange) this.onSessionChange(this.session);
  }

  // ==========================================================
  // 用户
  // ==========================================================

  /** 当前登录用户详情 */
  async getUserDetail() {
    return this.call('user_detail');
  }

  /** VIP 信息 */
  async getUserVipDetail() {
    return this.call('user_vip_detail');
  }

  /**
   * 我的歌单列表
   * 注意：这是「同步」的关键 —— 歌单存在酷狗服务器上，
   * 电脑端和手机端登录同一账号，拿到的天然是同一份。
   */
  async getUserPlaylists({ page = 1, pagesize = 30 } = {}) {
    return this.call('user_playlist', { page, pagesize });
  }

  /** 最近播放 */
  async getUserHistory({ page = 1, pagesize = 30 } = {}) {
    return this.call('user_history', { page, pagesize });
  }

  /** 云盘歌曲 */
  async getUserCloud({ page = 1, pagesize = 30 } = {}) {
    return this.call('user_cloud', { page, pagesize });
  }

  // ==========================================================
  // 歌单
  // ==========================================================

  async getPlaylistDetail(id) {
    return this.call('playlist_detail', { id });
  }

  /** 歌单内全部歌曲 */
  async getPlaylistTracks(id, { page = 1, pagesize = 30 } = {}) {
    return this.call('playlist_track_all', { id, page, pagesize });
  }

  /**
   * 新建歌单。
   *
   * @param {string} name      歌单名
   * @param {number} [isPrivate] 0 公开 / 1 私密
   *
   * 注意 type: 0 —— 这一项决定"建自己的歌单"还是"收藏别人的歌单"。
   * type 非 0 时接口要的是被收藏歌单的 list_create_* 三个字段，
   * 那些字段这里不传，传了反而会把请求变成"收藏"。
   */
  async createPlaylist(name, isPrivate = 0) {
    return this.call('playlist_add', {
      name,
      type: 0,
      is_pri: isPrivate ? 1 : 0,
      source: 1,
    });
  }

  /**
   * 删除歌单。
   *
   * @param {string|number} listid 歌单 listid（不是 global_collection_id）
   */
  async deletePlaylist(listid) {
    return this.call('playlist_del', { listid });
  }

  /**
   * 往歌单里加歌。
   *
   * @param {string|number} listid
   * @param {Array} songs 歌曲对象数组，需要 name / hash；
   *                      album_id 与 mixsongid 缺失时传 0 也能加进去，
   *                      但带上更稳妥（酷狗会据此匹配到正确的音源）
   *
   * 接口要的 data 是一个**竖线分隔的字符串**，多首用逗号连接：
   *   "歌名|hash|album_id|mixsongid,歌名2|hash2|..."
   * 每段内部的歌名如果自带逗号/竖线会破坏格式，所以这里统一清掉。
   */
  async addPlaylistTracks(listid, songs = []) {
    const clean = (v) => String(v == null ? '' : v).replace(/[|,]/g, ' ');
    const data = songs
      .filter((s) => s && s.hash)
      .map((s) =>
        [
          clean(s.name),
          clean(s.hash),
          Number(s.albumId || s.album_id || 0),
          /*
           * mixsongid 的取值顺序很重要。
           *
           * 搜索结果的字段名和歌单的不一样：歌单里叫 add_mixsongid / mixsongid，
           * 而搜索结果里**这三个都不存在**，有值的是 `Audioid`。
           * 所以必须把 albumAudioId 也作为候选 —— 实测漏了它就会一路传 0，
           * 酷狗直接回 [30203] 未知错误（歌认不出来）。
           */
          Number(s.mixSongId || s.mixsongid || s.albumAudioId || s.album_audio_id || s.fileId || 0),
        ].join('|')
      )
      .join(',');
    if (!data) throw new Error('没有可添加的歌曲（缺少 hash）');
    return this.call('playlist_tracks_add', { listid, data });
  }

  /**
   * 从歌单里删歌。
   *
   * @param {string|number} listid
   * @param {Array<string|number>} fileIds 每首歌的 fileid（不是 hash）
   *
   * 这个接口只认 fileid，而搜索结果里不一定带 —— 调用方要先用
   * playlist_track_all 拿到该歌单的曲目（那份数据里才有 fileid）。
   */
  async removePlaylistTracks(listid, fileIds = []) {
    const ids = fileIds
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (!ids.length) throw new Error('没有可删除的歌曲（缺少 fileid）');
    return this.call('playlist_tracks_del', { listid, fileids: ids.join(',') });
  }

  // ==========================================================
  // 歌曲 / 歌词
  // ==========================================================

  /**
   * 取播放地址
   *
   * @param {object} p
   * @param {string} p.hash          歌曲 hash（搜索结果里的 hash 字段）
   * @param {string|number} [p.albumId]     专辑 id
   * @param {string|number} [p.albumAudioId] 专辑音频 id
   * @param {string|number} [p.quality]     128 / 320 / flac / hires
   *
   * 注意：非 VIP 账号对付费歌曲只能拿到试听片段（free_part），
   * 这是平台侧的限制，不是程序问题。
   */
  async getSongUrl({ hash, albumId = 0, albumAudioId = 0, quality = 128, freePart = false }) {
    return this.call('song_url', {
      hash,
      album_id: albumId,
      album_audio_id: albumAudioId,
      quality,
      free_part: freePart,
    });
  }

  /**
   * 取可直接喂给播放器的地址（推荐用这个，而不是 getSongUrl）
   *
   * 走两条路，按可靠性排序：
   *   1. 移动端端点 m.kugou.com —— 不需要签名，返回 **https** 地址。
   *      安卓自 API 28 起默认禁止明文 HTTP，所以这条路是移动端的必需项。
   *   2. 网关路径（vendor 的 song_url）—— 备用；返回 http 地址，
   *      在手机上需要额外开启明文流量或做代理。
   *
   * 两条都拿到不到时会带 restricted 标志和原因，供界面给出准确提示。
   *
   * @returns {Promise<ReturnType<typeof normalizeSongUrl>>}
   */
  async getSongStream({ hash, albumId = 0, albumAudioId = 0, quality = 128, freePart = false }) {
    // ---- 路径 1：移动端端点 ----
    try {
      const info = await webApi.getSongInfo(hash, albumId, {
        isVip: Number(this.session.vip_type) > 0,
      });
      if (info.ok && info.url) {
        return {
          url: info.url,
          backupUrls: Array.isArray(info.backupUrl) ? info.backupUrl : [],
          extName: info.extName,
          fileSize: info.fileSize,
          durationMs: info.durationSec * 1000,
          restricted: false,
          failProcess: [],
          source: 'mobile',
          trial: info.trial,
        };
      }
      // 端点明确说「需要付费」这类，就不用再试网关了，但先记下来
      this._lastMobileReason = info.reason;
    } catch (e) {
      this._lastMobileReason = e.message;
    }

    // ---- 路径 2：网关 ----
    // 注意：网关对受限内容会直接 reject（如 error_code 35104 "Hash not found"、
    // 或者 20028「本次请求需要验证」），必须接住，否则受限歌曲会让整条链崩掉，
    // 而受限是正常的平台行为，不该当异常抛给界面。
    try {
      const res = await this.getSongUrl({ hash, albumId, albumAudioId, quality, freePart });
      const normalized = normalizeSongUrl(res.body);
      normalized.source = 'gateway';
      if (!normalized.url && this._lastMobileReason && normalized.failProcess.length === 0) {
        normalized.failProcess = [this._lastMobileReason];
      }
      return normalized;
    } catch (e) {
      const body = (e && e.body) || {};
      const reason = body.error || body.error_msg || this._lastMobileReason || (e && e.message) || '未知错误';
      return {
        url: null,
        backupUrls: [],
        extName: null,
        fileSize: 0,
        durationMs: 0,
        restricted: true,
        failProcess: [String(reason)],
        source: 'none',
      };
    }
  }

  /**
   * 取歌词
   *
   * 走 krcs.kugou.com 两步式接口：先搜候选 → 再按 id+accesskey 下载。
   * fmt='krc' 是逐字歌词（需解密解压），'lrc' 是普通歌词（纯文本）。
   *
   * @param {object} p
   * @param {string} p.name      歌名（配合歌手名提高命中率）
   * @param {string} [p.artist]  歌手名
   * @param {string} [p.hash]    歌曲 hash，能显著提高命中率
   * @param {'krc'|'lrc'} [p.fmt]
   * @returns {Promise<{ok:boolean, text:string|null, format:string|null, isWordByWord:boolean, candidate:object|null}>}
   */
  async getLyric({ name, artist, hash, fmt = 'krc' }) {
    const keyword = [name, artist].filter(Boolean).join(' - ');
    const candidates = await webApi.searchLyric(keyword, hash);
    if (!candidates.length) {
      return { ok: false, text: null, format: null, isWordByWord: false, candidate: null };
    }

    // 优先挑和歌曲 hash 完全匹配的候选，其次取第一个
    const best =
      candidates.find((c) => hash && String(c.hash).toLowerCase() === String(hash).toLowerCase()) || candidates[0];

    const dl = await webApi.downloadLyric(best.id, best.accesskey, fmt);
    if (!dl.ok) {
      return { ok: false, text: null, format: null, isWordByWord: false, candidate: best };
    }

    let text = null;
    let isWordByWord = false;

    if (dl.isKrc) {
      // KRC：XOR 解密 + zlib 解压，解出来是 [起始ms,时长ms]<0,偏移,0>字... 的逐字格式
      text = decodeLyrics(dl.buffer);
      isWordByWord = true;
      if (!text) {
        // 解不出就退回普通歌词，别让界面空着
        const fallback = await webApi.downloadLyric(best.id, best.accesskey, 'lrc');
        text = fallback.ok ? fallback.buffer.toString('utf8') : null;
        isWordByWord = false;
      }
    } else {
      text = dl.buffer.toString('utf8');
    }

    return {
      ok: Boolean(text),
      text,
      format: isWordByWord ? 'krc' : 'lrc',
      isWordByWord,
      candidate: best,
    };
  }

  // ==========================================================
  // 搜索
  // ==========================================================

  /**
   * 搜索歌曲
   *
   * 走公开 Web 端点 songsearch.kugou.com（无需签名，实测可用）。
   * vendor 里的网关搜索接口 gateway/v3/search/song 目前稳定返回
   * error_code 152 Parameter Error，已不可用，因此不再作为主路径。
   *
   * @param {string} keywords
   * @returns {Promise<{total:number, page:number, pagesize:number, songs:Array}>}
   */
  async search(keywords, { page = 1, pagesize = 20 } = {}) {
    return webApi.searchSongs(keywords, {
      page,
      pagesize,
      // 设备 GUID 本身就是 md5 hex（32 位），直接当 Web 端 mid 用，保证同一设备稳定
      mid: this.device.KUGOU_API_GUID,
    });
  }

  /* ------------------------------------------------------------------ */
  /* 歌手 / 专辑（用于详情页）                                          */
  /* ------------------------------------------------------------------ */

  /** 歌手详情。返回原始 data（对象），字段映射交给上层 */
  async getArtistDetail(artistId) {
    const res = await this.call('artist_detail', { id: Number(artistId) || 0 });
    return (res.body && res.body.data) || null;
  }

  /** 歌手的歌。返回**扁平**的歌曲数组 */
  async getArtistSongs(artistId, { page = 1, pagesize = 30 } = {}) {
    const res = await this.call('artist_audios', {
      id: Number(artistId) || 0,
      page,
      pagesize,
    });
    const d = res.body && res.body.data;
    return Array.isArray(d) ? d : [];
  }

  /** 歌手的专辑列表 */
  async getArtistAlbums(artistId, { page = 1, pagesize = 30 } = {}) {
    const res = await this.call('artist_albums', {
      id: Number(artistId) || 0,
      page,
      pagesize,
    });
    const d = res.body && res.body.data;
    return Array.isArray(d) ? d : [];
  }

  /**
   * 专辑详情。
   * ★ 注意这个接口返回的是**单元素数组**（请求体里就是 data:[{album_id}]），
   *   直接当对象用会拿到 undefined —— 我第一次就取错了。
   */
  async getAlbumDetail(albumId) {
    const res = await this.call('album_detail', { id: Number(albumId) || 0 });
    const d = res.body && res.body.data;
    if (Array.isArray(d)) return d[0] || null;
    return d || null;
  }

  /** 专辑的歌。返回 { total, songs }（songs 是嵌套结构，映射交给上层） */
  async getAlbumSongs(albumId, { page = 1, pagesize = 30 } = {}) {
    const res = await this.call('album_songs', {
      id: Number(albumId) || 0,
      page,
      pagesize,
    });
    const d = (res.body && res.body.data) || {};
    return { total: Number(d.total) || 0, songs: Array.isArray(d.songs) ? d.songs : [] };
  }

  /** 搜索建议（输入联想） */
  async searchSuggest(keywords) {
    return this.call('search_suggest', { keywords });
  }

  // ==========================================================
  // 推荐 / 排行
  // ==========================================================

  /** 每日推荐 */
  async getEverydayRecommend({ page = 1, pagesize = 30 } = {}) {
    return this.call('everyday_recommend', { page, pagesize });
  }

  /** 私人 FM */
  async getPersonalFm() {
    return this.call('personal_fm');
  }

  /** 排行榜列表 */
  async getRankList() {
    return this.call('rank_list');
  }

  /** 排行榜歌曲 */
  async getRankAudio({ rankId, page = 1, pagesize = 30 } = {}) {
    return this.call('rank_audio', { rankid: rankId, page, pagesize });
  }

  // ==========================================================
  // 播放历史上报（跨设备续播的数据来源）
  // ==========================================================

  /**
   * 上报播放历史。
   * 酷狗官方 App / 网页端会读这份数据来显示「继续播放」，
   * 所以两端只要都上报，就能互相接上进度。
   */
  async uploadPlayHistory({ mxid = 0, mixSongId = 0, albumAudioId = 0, pc = 1, time = 0 } = {}) {
    /*
     * ★ 参数名必须和 vendor 模块对齐。
     *
     * 模块里是：
     *   const songs = [{ mxid: Number(params.mxid), op: 1, ot: Number(params.time), pc: Number(params.pc) }];
     * 而这里原来传的是 hash / album_id / album_audio_id / seconds / total ——
     * 模块一个都不读，mxid 于是变成 Number(undefined) = NaN。
     * 也就是说这个函数以前**即使被调用也是坏的**（只是从来没人调用，所以没暴露）。
     *
     * mxid 就是搜索结果里的 MixSongID，也是「最近播放」返回项里的 mxid ——
     * 两边字段名一致，可以互相印证。
     */
    const id = Number(mxid || mixSongId || albumAudioId || 0);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('缺少 mxid（mix song id），无法上报播放历史');
    }
    return this.call('playhistory_upload', { mxid: id, pc, time });
  }

  /** 最近听歌（另一条跨设备续播的数据来源） */
  async getLatestListen() {
    return this.call('lastest_songs_listen');
  }

  // ==========================================================
  // 喜欢 / 收藏
  // ==========================================================

  /**
   * 找「我喜欢」歌单的 listid
   *
   * 注意这里要的是 `list_create_listid`（客户端的本地编号，实测是 2），
   * **不是** `global_collection_id`。加歌/删歌接口都认前者。
   */
  async getFavoriteListId(force = false) {
    if (!force && this._favListId) return this._favListId;

    const res = await this.getUserPlaylists({ page: 1, pagesize: 100 });
    const list = (res.body && res.body.data && (res.body.data.info || res.body.data.list)) || [];
    const nameOf = (p) => String(p.name || p.list_create_list_name || '');

    // 注意匹配顺序：「默认收藏」在列表里排在「我喜欢」前面，而且只是个空壳歌单。
    // 必须优先精确匹配「我喜欢」，否则点赞会全加到错误的歌单里。
    const fav =
      list.find((p) => nameOf(p).trim() === '我喜欢') ||
      list.find((p) => /我喜欢/.test(nameOf(p))) ||
      list.find((p) => /默认收藏/.test(nameOf(p)));

    if (!fav) throw new Error('账号里没有找到「我喜欢」歌单');

    this._favListId = fav.list_create_listid;
    this._favGid = fav.global_collection_id;
    this._favCount = Number(fav.m_count) || 0;
    return this._favListId;
  }

  /**
   * 加入「我喜欢」
   * @param {{name:string, hash:string, albumId:number|string, mixSongId:number|string}} song
   */
  async addToFavorites(song) {
    const listid = await this.getFavoriteListId();
    // 接口约定的拼接格式：名字|hash|album_id|mixsongid
    const data = [
      song.name || '',
      song.hash || '',
      Number(song.albumId) || 0,
      Number(song.mixSongId) || 0,
    ].join('|');

    const res = await this.call('playlist_tracks_add', { listid, data });
    // 收藏数变了，缓存里的已喜欢集合要作废
    this._favHashes = null;
    return res;
  }

  /**
   * 从「我喜欢」移除
   *
   * 可以传 fileid，也可以传 hash —— 传 hash 时会先在歌单里反查。
   * 因为 fileid 是"歌在歌单里的条目号"，从搜索结果来的歌拿不到它。
   *
   * @param {number|string} fileIdOrHash
   */
  async removeFromFavorites(fileIdOrHash) {
    const listid = await this.getFavoriteListId();

    let fileId = fileIdOrHash;
    if (typeof fileId === 'string' && /^[0-9a-f]{32}$/i.test(fileId)) {
      fileId = await this.findFavoriteFileId(fileId);
      if (!fileId) throw new Error('这首歌不在「我喜欢」里');
    }

    const res = await this.call('playlist_tracks_del', { listid, fileids: String(fileId) });
    this._favHashes = null;
    return res;
  }

  /**
   * 在「我喜欢」里按 hash 找 fileid
   * @param {string} hash
   * @returns {Promise<number|null>}
   */
  async findFavoriteFileId(hash) {
    if (!this._favGid) await this.getFavoriteListId();
    const want = String(hash || '').toLowerCase();

    for (let page = 1; page <= 40; page++) {
      const res = await this.getPlaylistTracks(this._favGid, { page, pagesize: 100 });
      const data = (res.body && (res.body.data || res.body)) || {};
      const songs = data.songs || data.info || data.lists || data.list || data.audios || [];
      if (!Array.isArray(songs) || songs.length === 0) break;

      const hit = songs.find((s) => String(s.hash || '').toLowerCase() === want);
      if (hit) return hit.fileid || hit.file_id || null;

      if (songs.length < 100) break;
    }
    return null;
  }

  /**
   * 拉取「我喜欢」的全部 hash 集合，用于判断某首歌是否已喜欢
   *
   * 一次拉全量比较重（可能上千首），所以结果缓存在实例上；
   * 加/删收藏时会作废缓存，下次重新拉。
   * @returns {Promise<Set<string>>} 小写的 hash 集合
   */
  async getFavoriteHashes({ force = false, maxPages = 40 } = {}) {
    if (!force && this._favHashes) return this._favHashes;

    if (!this._favGid) await this.getFavoriteListId();
    const gid = this._favGid;
    const set = new Set();

    for (let page = 1; page <= maxPages; page++) {
      const res = await this.getPlaylistTracks(gid, { page, pagesize: 100 });
      const data = (res.body && (res.body.data || res.body)) || {};
      const songs = data.songs || data.info || data.lists || data.list || data.audios || [];
      if (!Array.isArray(songs) || songs.length === 0) break;
      for (const s of songs) {
        if (s.hash) set.add(String(s.hash).toLowerCase());
      }
      if (songs.length < 100) break;
    }

    this._favHashes = set;
    return set;
  }
}

/** 会话字段白名单，供 App 持久化时过滤 */
KuGouClient.SESSION_KEYS = SESSION_KEYS;

module.exports = { KuGouClient, SESSION_KEYS, modules, collectUrls, normalizeSongUrl };
