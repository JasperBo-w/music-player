'use strict';

/**
 * 酷狗公开 Web / 移动端接口
 *
 * 为什么要有这个文件（而不是全走 vendor 里的网关接口）：
 *
 *  1. **搜索**：vendor 的 `search` 走网关 `gateway.kugou.com/v3/search/song`，
 *     现在稳定返回 `error_code 152 Parameter Error`。这里的
 *     `songsearch.kugou.com/song_search_v2` 是公开 Web 端点，无需 signature，
 *     实测可用，是搜索的唯一可行路径。
 *
 *  2. **播放地址的协议**：网关路径返回的是 `http://fsandroid.tx.kugou.com/...`，
 *     而 Android 自 API 28 起默认禁止明文 HTTP 流量，手机上会被系统直接拦掉。
 *     移动端端点 `m.kugou.com/app/i/getSongInfo.php` 返回的是
 *     `https://sharefs.kugou.com/...`，天然可用于移动端。
 *
 *  3. **歌词**：`krcs.kugou.com` 的 search + download 两步式接口，
 *     比 vendor 的 lyric 模块更直接，且能拿到逐字歌词（KRC）。
 *
 * 端点与参数结构参考自 Mineradio (GPL-3.0) 的 kugou-api.js 实现，
 * 代码为本项目独立编写。详见项目根目录 NOTICE.md。
 */

// 传输层与哈希都必须同时适配 Node（Electron 主进程）和浏览器（手机端 WebView）：
//   - Node 有 node:http/node:https/node:crypto
//   - WebView 只有 fetch / Web Crypto
// 所以这里优先用 fetch（两端都有），没有 fetch 时才回落到 Node 的 http 模块。
// MD5 统一走 crypto-js（纯 JS 实现，两端一致），不用 node:crypto。

const { cryptoMd5 } = require('./kugou/vendor/util/crypto');

const SEARCH_URL = 'https://songsearch.kugou.com/song_search_v2';
const SONG_INFO_URL = 'https://m.kugou.com/app/i/getSongInfo.php';
const LYRIC_SEARCH_URL = 'https://krcs.kugou.com/search';
const LYRIC_DOWNLOAD_URL = 'https://krcs.kugou.com/download';

const WEB_APPID = '1014';

const HEADERS = {
  Referer: 'https://www.kugou.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const md5 = (s) => cryptoMd5(String(s));

/** 播放地址的 key 参数：md5(hash + 'kgcloud') */
const cloudKey = (hash) => md5(String(hash || '') + 'kgcloud');

/** 生成一个 Web 端用的 mid（30 位以内并不是硬要求，hex md5 即可） */
function createMid(seed) {
  return md5(String(seed || Date.now()) + Math.random());
}

/** 把 base64 解成 Uint8Array，两端通用（不依赖 Buffer） */
function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node 环境
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

/** Node 环境下用 http/https 模块发请求（fetch 不可用时的兜底） */
function nodeRequest(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    let httpMod;
    try {
      httpMod = url.startsWith('https:') ? require('node:https') : require('node:http');
    } catch (e) {
      return resolve({ error: `当前环境既没有 fetch 也没有 node http 模块: ${e.message}` });
    }

    const req = httpMod.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 有些端点返回 HTML 包裹的 JSON */ }
        resolve({ status: res.statusCode, text, json, contentType: res.headers['content-type'] });
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

/**
 * 基础 HTTP 请求，返回解析后的 JSON 或文本
 *
 * 优先使用 fetch（Electron 渲染进程 / WebView / 新版 Node 都有），
 * 这样同一份代码在桌面端和手机端行为一致。
 */
function request(url, { headers, timeoutMs = 15000 } = {}) {
  const merged = Object.assign({}, HEADERS, headers || {});

  if (typeof fetch === 'function') {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    return fetch(url, { headers: merged, signal: controller ? controller.signal : undefined })
      .then(async (res) => {
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* 保留原文 */ }
        return { status: res.status, text, json, contentType: res.headers.get('content-type') };
      })
      .catch((e) => ({ error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || String(e) }))
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  return nodeRequest(url, merged, timeoutMs);
}

/** 剥掉搜索结果里的 <em> 高亮标签并解码实体 */
function stripHtml(text) {
  let s = String(text == null ? '' : text).replace(/<[^>]+>/g, '').trim();
  if (/%u[0-9a-fA-F]{4}/.test(s)) {
    s = s.replace(/%u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.trim();
}

/** 把 song_search_v2 的一条结果规整成播放器好用的形状 */
function normalizeSearchItem(item) {
  /*
   * ★ MixSongID 必须排在 Audioid 前面。
   *
   * 这两个字段在同一条搜索结果里**值完全不同**（实测）：
   *     In The Shadow Of The Sun   Audioid: 636157239   MixSongID: 945254464
   *     Faded Deep                 Audioid: 651263351   MixSongID: 961293837
   * 而网关取流的地址里拼的是 `..._mx<mixsongid>_qu128...` ——
   * 填 Audioid 的话酷狗会按一个**不对的 id** 去解析，返回另一首歌。
   *
   * 用户的现象正是如此："歌名是对的，点播放出来的是别的歌"。
   * 之所以只是"有的歌"出问题：移动端那条路（只用 hash + album_id）成功时
   * 根本用不到这个值，只有它失败、回落到网关时才会踩到这个坑。
   */
  const mixId = item.MixSongID || item.EMixSongID || item.Audioid || '';
  return {
    id: String(mixId || ''),
    hash: item.FileHash || '',
    name: stripHtml(item.SongName),
    artist: stripHtml(item.SingerName),
albumId: item.AlbumID || 0,
    /*
     * artistId —— 歌手页需要它。原始字段是 PascalCase 的 SingerId；
     * Singers 数组里也有 id，作为兜底（不同接口给的不一样）。
     */
    artistId: item.SingerId || (Array.isArray(item.Singers) && item.Singers[0] && item.Singers[0].id) || 0,
    albumAudioId: mixId || 0,
    albumName: stripHtml(item.AlbumName || ''),
    durationSec: Number(item.Duration) || 0,
    /*
     * Category —— 内容类型。用来把"听书 / 长音频"挡在搜索结果外。
     *   1 = 歌曲      2 = 长音频（评书、有声小说）
     *
     * 实测搜「评书」返回的全是《韩复榘传奇》第 199 回这类条目，
     * 而它们的 Type 同样是 "audio"、Privilege 也正常 —— 靠 Type 根本过滤不掉。
     * Category 是唯一干净可靠的判据（旁证：这些条目的 QualityLevel=1、
     * SingerId=[0,0]、HQFileHash 为空，而正常歌曲分别是 3 / [数字] / 有值）。
     */
    category: Number(item.Category) || 0,
    // 平台侧版权标记：privilege <= 8 一般可播，越大限制越多
    privilege: Number(item.Privilege) || 0,
    // 更高音质对应的 hash，没有则为空
    hqHash: item.HQFileHash || '',
    sqHash: item.SQFileHash || '',
    resHash: item.ResFileHash || '',
  };
}

/**
 * 搜索歌曲（公开 Web 端点，无需签名）
 * @param {string} keywords
 * @param {{page?: number, pagesize?: number, mid?: string}} [opts]
 */
async function searchSongs(keywords, opts = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  /*
   * 上限从 30 放到 100。
   * 原来的 30 是我自己加的限制，不是接口的 —— 实测 pagesize=100 能正常返回 100 条。
   * （酷狗这个端点对 pagesize 的实际容忍度就是 100 左右，再大没试过也不必要：
   *   界面按 50 一页拉，"加载更多"翻页即可。）
   */
  const pagesize = Math.max(1, Math.min(Number(opts.pagesize) || 20, 100));

  const u = new URL(SEARCH_URL);
  const p = u.searchParams;
  p.set('keyword', keywords);
  p.set('page', String(page));
  p.set('pagesize', String(pagesize));
  p.set('userid', '-1');
  p.set('clientver', '2000');
  p.set('platform', 'WebFilter');
  p.set('tag', 'em');
  p.set('filter', '2');
  p.set('iscorrection', '1');
  p.set('privilege_filter', '0');
  p.set('filter_ver', '2');
  p.set('appid', WEB_APPID);
  p.set('token', '');
  p.set('mid', opts.mid || createMid());

  const res = await request(u.toString());
  if (res.error) throw new Error(`搜索请求失败: ${res.error}`);
  if (!res.json || !res.json.data || !Array.isArray(res.json.data.lists)) {
    throw new Error(`搜索返回异常: ${String(res.text).slice(0, 200)}`);
  }

  return {
    total: Number(res.json.data.total) || 0,
    page,
    pagesize,
    /*
     * 过滤掉听书 / 长音频。
     *
     * 两条判据，缺一不可：
     *   ① category === 2 —— 主判据。搜「评书」时 12 条里能滤掉 11 条。
     *   ② 时长 > 30 分钟 —— 兜底。Category 并不严密：实测有个
     *      《第十五案_银色马》标的是 Category 1、时长 4165 秒（69 分钟），
     *      只靠 ① 会漏掉。一首歌超过 30 分钟基本不存在，这条线很安全。
     *
     * 判据写成 `category !== 2` 而不是 `=== 1`：万一以后酷狗加了新的
     * 分类编号，前者不会误杀，后者会。category 缺失（0）也保留。
     */
    songs: res.json.data.lists
      .map(normalizeSearchItem)
      .filter((s) => s.name && s.hash && s.category !== 2 && s.durationSec <= 1800),
  };
}

/**
 * 取播放地址（移动端端点，返回 https 地址）
 *
 * 优点：不需要 signature、不需要登录、返回 https。
 * 限制：付费歌曲会返回 status=0「需要付费」，这是平台侧限制。
 *
 * @param {string} hash
 * @param {number|string} [albumId]
 * @param {{isVip?: boolean, timeoutMs?: number}} [opts]
 */
async function getSongInfo(hash, albumId = 0, opts = {}) {
  const u = new URL(SONG_INFO_URL);
  const p = u.searchParams;
  p.set('cmd', 'playInfo');
  p.set('hash', String(hash || ''));
  p.set('key', cloudKey(hash));
  p.set('album_id', String(albumId || 0));
  p.set('pid', '1');
  p.set('forceDown', '0');
  // 非会员传 65530（酷狗客户端里的「无会员」哨兵值）
  p.set('vip', opts.isVip ? '1' : '65530');

  const res = await request(u.toString(), {
    headers: { Referer: 'https://m.kugou.com/' },
    timeoutMs: opts.timeoutMs || 15000,
  });
  if (res.error) throw new Error(`取播放地址失败: ${res.error}`);

  const j = res.json || {};
  const ok = Number(j.status) === 1 && j.url;

  return {
    ok: Boolean(ok),
    url: ok ? j.url : null,
    backupUrl: ok && j.backupUrl ? j.backupUrl : null,
    // 服务端给出的原因，如「需要付费」，用于界面提示
    reason: ok ? null : j.error || j.err || '未知原因',
    fileName: j.fileName || null,
    bitRate: Number(j.bitRate) || 0,
    durationSec: Number(j.timeLength) || 0,
    fileSize: Number(j.fileSize) || 0,
    extName: j.extName || null,
    // 是否只是试听片段
    trial: Boolean(j.fileHead || j.IsFreePart),
    raw: j,
  };
}

/**
 * 歌词：搜索候选
 * @param {string} keyword 一般传「歌名 - 歌手」
 * @param {string} [hash]  歌曲 hash，能显著提高命中率
 */
async function searchLyric(keyword, hash) {
  const u = new URL(LYRIC_SEARCH_URL);
  u.searchParams.set('ver', '1');
  u.searchParams.set('man', 'yes');
  u.searchParams.set('client', 'mobi');
  u.searchParams.set('keyword', keyword);
  if (hash) u.searchParams.set('hash', hash);

  const res = await request(u.toString());
  if (res.error) throw new Error(`歌词搜索失败: ${res.error}`);
  return (res.json && res.json.candidates) || [];
}

/**
 * 歌词：下载
 * @param {string|number} id
 * @param {string} accesskey
 * @param {'krc'|'lrc'} [fmt] krc = 逐字歌词，lrc = 普通歌词
 */
async function downloadLyric(id, accesskey, fmt = 'krc') {
  const u = new URL(LYRIC_DOWNLOAD_URL);
  u.searchParams.set('ver', '1');
  u.searchParams.set('client', 'pc');
  u.searchParams.set('id', String(id));
  u.searchParams.set('accesskey', String(accesskey));
  u.searchParams.set('fmt', fmt);
  u.searchParams.set('charset', 'utf8');

  const res = await request(u.toString());
  if (res.error) throw new Error(`歌词下载失败: ${res.error}`);

  const j = res.json || {};
  if (!j.content) return { ok: false, content: null, raw: j };

  const bytes = base64ToBytes(j.content);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  // KRC 是加密+压缩的，交给 vendor 里的 decodeLyrics 解；
  // LRC 是纯文本，直接当字符串用。
  return { ok: true, buffer: bytes, isKrc: fmt === 'krc' && magic === 'krc1', raw: j };
}

module.exports = {
  searchSongs,
  getSongInfo,
  searchLyric,
  downloadLyric,
  stripHtml,
  cloudKey,
  createMid,
  request,
  // 端点常量导出，方便排查和测试
  ENDPOINTS: { SEARCH_URL, SONG_INFO_URL, LYRIC_SEARCH_URL, LYRIC_DOWNLOAD_URL },
};
