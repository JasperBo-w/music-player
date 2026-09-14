'use strict';

/**
 * Electron 主进程
 *
 * 职责分工：
 *   - 音源核心（@dsh/music-core）跑在这里，请求由 Node 发出，
 *     完全不受浏览器同源策略限制，也不需要任何跨域代理。
 *   - 渲染进程只做界面，通过 preload 暴露的 window.api 调用这里。
 *
 * 会话持久化：设备身份 + 登录态存到 Electron 的 userData 目录，
 * 设备身份必须持久化，否则每次启动都换新身份会被酷狗判为异常设备。
 */

const path = require('node:path');
/*
 * fs 必须在**模块顶层**引一次。
 *
 * 这个文件里原先有三处 const fs = require('node:fs')，但都在函数内部 ——
 * 模块级的 loadWindowState / saveWindowState 拿不到它们。
 * 表现就是 "fs is not defined"，而且被我那个空的 catch{} 吞掉，
 * 变成"窗口位置记不住但毫无线索"。
 */
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  protocol,
  net,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  screen,
} = require('electron');

/* ------------------------------------------------------------------ */
/* 单实例                                                              */
/* ------------------------------------------------------------------ */

/*
 * 为什么必须有：没有它，双击图标就多开一个 ——
 * 两个实例会**抢同一个 session 文件**（登录态可能被写坏），
 * 托盘里还会冒出两个图标，媒体键也会被两份注册互相打架。
 *
 * 第二个实例不自己干活：拿到锁的失败方直接退出，
 * 而已经在跑的那个收到 second-instance 事件后把窗口亮出来 ——
 * 用户看到的效果是"点图标，窗口就出来了"，符合直觉。
 * 注意要连托盘里藏着的窗口一起处理（hide 过就 show 回来）。
 */
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });
}

const { KuGouClient } = require('@dsh/music-core');
const { FileSessionStore } = require('@dsh/music-core/src/session-store.js');

const DEV_URL = process.env.MUSIC_UI_DEV_URL || '';
const isDev = Boolean(DEV_URL);

/*
 * 强制使用高性能独显。
 *
 * 这台机器是双显卡笔记本（Intel UHD 核显 + NVIDIA RTX 5060 独显）。Windows 上
 * Chromium 默认会把应用挂到**核显**上跑，独显全程闲着 —— 实测 getGPUInfo 和
 * WebGL 的 UNMASKED_RENDERER 都报 "Intel(R) UHD Graphics"，也就是粒子、泛光、
 * 整个画面都在核显上画。这是所有掉帧问题的根源。
 *
 * `force_high_performance_gpu` 是 Chromium 自带的开关，专门用来在双显卡机器上
 * 指定用独显。必须在 app ready 之前调用才生效。
 *
 * 注意 WebGL 的 `powerPreference: 'high-performance'` **不够** —— 在 Windows 上
 * 那只是个偏好提示，Chromium 通常不理它，真正管用的是这个命令行开关。
 *
 * 另外两个层面的设置可以叠加（由用户在系统里配，代码管不到）：
 *   - Windows 设置 → 系统 → 显示 → 显卡 → 把这个 exe 设为"高性能"
 *   - NVIDIA 控制面板 → 管理 3D 设置 → 程序设置 → 首选"高性能 NVIDIA 处理器"
 */
/*
 * GPU 选择。默认强制独显，但可以用 MP_GPU 覆盖来做 A/B：
 *   MP_GPU=high（默认）强制独显 / low 强制核显 / none 不加任何开关
 *
 * 为什么要能测这个：实测"只要有 WebGL 在出图，就固定多花约 5ms，
 * 且 p95 有一条 28ms 的尾巴"，而这条尾巴跟画面内容、分辨率、泛光、
 * 磨砂、UI 层、desynchronized **全都无关**，主线程每帧只占约 1ms。
 * 剩下的可能就落在"画面到底由哪块显卡呈现"上 ——
 * 这是一台双显卡笔记本，如果渲染在独显、内屏却接在核显上，
 * 每一帧都要跨显卡拷一次，而这个开销恰好就是"固定、与内容无关"。
 * 改启动参数必须重启进程，所以把它做成环境变量，一次脚本跑完全部组合。
 */
const gpuPref = (process.env.MP_GPU || 'high').toLowerCase();
if (gpuPref === 'high') {
  app.commandLine.appendSwitch('force_high_performance_gpu');
} else if (gpuPref === 'low') {
  app.commandLine.appendSwitch('force_low_power_gpu');
}
// 额外开关，逗号分隔，例如 disable-direct-composition
if (process.env.MP_GPU_FLAGS) {
  for (const f of process.env.MP_GPU_FLAGS.split(',')) {
    const t = f.trim();
    if (t) app.commandLine.appendSwitch(t);
  }
}

/*
 * 自动测试时放开自动播放限制。
 *
 * Chromium 要求 audio.play() 必须由**真实用户手势**触发。正常使用时播放都是点出来的，
 * 没问题；但基准脚本是用 executeJavaScript 模拟点击的，不算用户手势，
 * 于是 audio.play() 被拒、音乐根本没起来 ——
 * 排查节拍问题时，探测脚本一直报"等 20 秒仍未起播（paused=true readyState=0）"，
 * 就是因为这个，白白浪费了一轮验证。
 * 只在自动测试模式下放开，正常运行不碰这条策略。
 */
if (process.env.MP_BENCH || process.env.MP_SHOT || process.env.MP_PULSE) {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

const UI_ROOT = path.join(__dirname, '..', 'ui');

/**
 * 为什么要自定义协议（app://）而不是直接 loadFile：
 *
 * Chromium 不允许从 file:// 加载 ES 模块（origin 是 null，被 CORS 拦），
 * 而本项目的界面刻意不用打包器，就是原生 ES 模块 + import map，
 * 所以必须有个"正经"的来源。注册一个 standard + secure 的 app:// 协议
 * 既能加载模块，又不用像传统做法那样额外起一个本地 HTTP 服务。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

function serveUiAsset(request) {
  const url = new URL(request.url);
  // app://bundle/xxx -> UI_ROOT/xxx；decodeURIComponent 处理中文文件名
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const target = path.join(UI_ROOT, rel);

  // 防目录穿越：解析后必须仍在 UI_ROOT 内
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(UI_ROOT))) {
    return new Response('Forbidden', { status: 403 });
  }

  return net.fetch(pathToFileURL(resolved).toString());
}

let store = null;
let client = null;

/* ------------------------------------------------------------------ */
/* 数据映射：把酷狗原始结构规整成界面好用的形状                          */
/* ------------------------------------------------------------------ */

const pick = (o, ...keys) => {
  for (const k of keys) {
    if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
};

/**
 * 从任意嵌套结构里挖出第一张图片地址
 *
 * 酷狗不同接口返回封面的字段名和位置都不一样：
 *   搜索结果是 imgUrl / AlbumImage，歌单歌曲藏在 trans_param.union_cover，
 *   榜单里又是 sizable_cover。逐个硬编码太脆，直接递归找。
 */
function findCover(obj, depth = 0) {
  if (depth > 4 || !obj || typeof obj !== 'object') return '';
  const KEYS = ['union_cover', 'sizable_cover', 'imgUrl', 'imgurl', 'album_img', 'cover', 'pic', 'image'];
  for (const k of KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v.replace('{size}', '400');
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findCover(v, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function mapPlaylist(raw) {
  return {
    // 必须用 global_collection_id：list_create_listid 是客户端本地编号，用它取歌会报 20010
    id: String(pick(raw, 'global_collection_id', 'list_create_gid', 'specialid', 'id') || ''),
    /*
     * listid —— **写**接口（加歌/删歌/删歌单）要的就是它，数字。
     *
     * 和上面的 id 是两个不同的东西，别混：
     *   id      = global_collection_id，形如 "collection_3_1406398940_26_0"，**读**用
     *   listid  = list_create_listid，形如 26，**写**用
     * 传错的话加歌回 [30203]，删歌单更阴 —— playlist_del 里是 Number(params.listid)，
     * 字符串进去变 NaN，接口不真删却返回得像成功。
     */
    listid: Number(pick(raw, 'list_create_listid', 'listid', 'list_id') || 0),
    name: String(pick(raw, 'name', 'list_create_list_name', 'specialname', 'playlist_name') || '未命名歌单'),
    count: Number(pick(raw, 'm_count', 'song_count', 'songcount', 'count', 'total') || 0),
    cover: String(pick(raw, 'pic', 'cover', 'imgurl') || '').replace('{size}', '240'),
  };
}

function mapSong(raw) {
  /*
   * ★ 这个函数要同时认三种"方言"，少认一种就会静默丢字段：
   *
   *   ① 裸的酷狗字段（PascalCase）  FileHash / SongName / AlbumID / Audioid
   *   ② 歌单接口的字段（snake_case） album_id / add_mixsongid / fileid
   *   ③ **已经归一化过的**（camelCase）hash / name / albumId / albumAudioId / mixSongId
   *
   * 第 ③ 种是我漏掉的那一种：web-api 的搜索结果出来就已经是 camelCase 了，
   * 而这里只找 ①②，于是 **albumId 恒为 0**。
   *
   * 后果不是"取不到歌"，而是"取到了另一首歌"：
   * 取流走移动端端点 getSongInfo(hash, albumId)，只带 hash 而 album_id=0 时，
   * 酷狗会解析到别的音频 —— 用户看到的就是
   * "歌名是对的，一点播放出来的却是另一首"（有些歌 hash 够独特所以没事）。
   */
  const albumId = pick(raw, 'albumId', 'album_id', 'albumid', 'AlbumID') || 0;

  // 搜索结果（song_search_v2）与歌单歌曲（get_other_list_file）字段名不同，这里统一
  const hash = pick(raw, 'hash', 'FileHash', 'file_hash') || '';
  const name = pick(raw, 'name', 'SongName', 'songname', 'song_name', 'audio_name', 'filename') || '';
  const artist = pick(raw, 'artist', 'SingerName', 'singername', 'singer_name', 'author_name') || '';
  /*
   * 注意 timelen 与 timelength **是两个不同的字段名**，都真实存在：
   *   搜索/歌单 → timelength
   *   播放历史   → timelen（毫秒）
   * 少写一个的后果是时长恒为 0 —— 列表里全是 0:00，但不报错、不影响播放，
   * 所以很容易漏过去。
   */
  const duration = pick(raw, 'durationSec', 'Duration', 'timelen', 'timelength', 'timeLength') || 0;
  const privilege = pick(raw, 'privilege', 'Privilege', 'priv');

  return {
    hash: String(hash),
    name: String(name).replace(/<[^>]+>/g, ''),
    artist: String(artist).replace(/<[^>]+>/g, ''),
albumId,
    /*
     * albumName —— 歌手页里那一列显示的就是它。
     * 三种方言都要认（和 albumId 同理）：camelCase / snake_case / PascalCase。
     * 缺了它，歌手页只能回落成显示歌手名（整页重复同一个名字，没有信息量）。
     */
    albumName: String(pick(raw, 'albumName', 'album_name', 'AlbumName') || '').replace(/<[^>]+>/g, ''),
    /*
     * artistId —— 歌手页要用。原始字段 SingerId（PascalCase），
     * 或者 Singers[0].id。缺了它歌手名就点不进去。
     */
    artistId: pick(raw, 'artistId', 'SingerId', 'singer_id', 'singerid') ||
      (Array.isArray(raw.Singers) && raw.Singers[0] && raw.Singers[0].id) || 0,
    /*
     * albumAudioId —— 优先取 mixsongid 一类，**不能拿 audio_id 顶替**。
     *
     * 歌单接口里同时有这两个且值不同（实测一首歌）：
     *     audio_id:       529497156
     *     add_mixsongid:  836176367      ← 真正的 mixsongid
     * 网关取流时它会拼进地址（`..._mx836176367_qu128...`）。
     *
     * camelCase 的 albumAudioId 放在最前 —— 归一化过的数据只剩它。
     */
    albumAudioId: pick(raw, 'albumAudioId', 'album_audio_id', 'mixsongid', 'add_mixsongid', 'Audioid', 'EMixSongID', 'audio_id') || 0,
    durationSec: Number(duration) > 10000 ? Math.round(Number(duration) / 1000) : Number(duration),
    privilege: Number(privilege || 0),
    cover: findCover(raw),
    // 收藏相关：加歌要 mixsongid，删歌要 fileid（两者都不是 hash，别混用）
    mixSongId: pick(raw, 'mixSongId', 'add_mixsongid', 'mixsongid', 'MixSongID', 'EMixSongID', 'albumAudioId') || 0,
    fileId: pick(raw, 'fileId', 'fileid', 'file_id') || 0,
    hqHash: pick(raw, 'hqHash', 'HQFileHash', 'hq_hash') || '',
    sqHash: pick(raw, 'sqHash', 'SQFileHash', 'sq_hash') || '',
  };
}

/* ------------------------------------------------------------------ */
/* 核心客户端                                                          */
/* ------------------------------------------------------------------ */

function getClient() {
  if (client) return client;

  // 会话文件位置：默认放 Electron 的 userData 目录。
  // 开发时可以用 MUSIC_SESSION_FILE 指定到别处（例如直接复用 CLI 脚本
  // 扫码登录后落盘的那份），免得在多个位置之间来回复制登录态。
  const sessionFile =
    process.env.MUSIC_SESSION_FILE || path.join(app.getPath('userData'), 'kugou-session.json');

  store = new FileSessionStore(sessionFile);
  const saved = store.load();

  client = new KuGouClient({
    device: saved.device,
    session: saved.session,
    onSessionChange: (session) => store.save({ device: client.device, session }),
  });

  // 设备身份只在第一次生成，之后复用
  if (!saved.device) store.save({ device: client.device, session: client.session });

  console.log(`[core] 会话文件   = ${sessionFile}`);
  console.log(`[core] 设备 MID   = ${client.device.KUGOU_API_MID}`);
  console.log(`[core] 登录态     = ${client.isLoggedIn ? `已登录 userid=${client.session.userid}` : '未登录'}`);
  return client;
}

/* ------------------------------------------------------------------ */
/* IPC 处理器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 从各种形状的错误对象里挖出一句人话。
 *
 * 核心库的失败路径有几种不同形状，直接取 e.message 经常会拿到对象：
 *   · request.js 网络异常:  body = { status: 0, msg: <Error 对象> }
 *   · 业务失败:            body = { error_code: 20010, error_msg: '...' }
 *   · axios 自身的错误:     e.response.data / e.message 是字符串
 * 拿不到字符串时退化成 String(对象) 就会变成「[object Object] 未知错误」——
 * 既看不出原因，也没法排查。这里逐个字段试，并顺手把嵌套的 message 挖出来。
 */
function describeError(e) {
  if (!e) return { code: '', msg: '未知错误' };

  const body = (e && e.body) || (e && e.response && e.response.data) || {};
  const code = body.error_code || body.errcode || e.errcode || '';

  // 按"越具体越靠前"的顺序找消息
  const candidates = [
    body.error_msg,
    body.errmsg,
    body.msg,
    body.error,
    body.message,
    typeof body.msg === 'object' && body.msg ? body.msg.message : '',
    e.message,
    e.response && e.response.statusText
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return { code, msg: c.trim() };
    // msg 是对象（上面那种 { status:0, msg: e } 的形状）时，再往里挖一层
    if (c && typeof c === 'object') {
      const inner = c.message || c.error_msg || c.errmsg;
      if (typeof inner === 'string' && inner.trim()) return { code, msg: inner.trim() };
    }
  }

  // 实在没有可读信息，至少给出 HTTP 状态，别只说"未知错误"
  const status = (e.response && e.response.status) || body.status || '';
  if (status) return { code, msg: `请求失败（HTTP ${status}）` };

  return { code, msg: '未知错误' };
}

/** 统一的错误包装：把酷狗的业务错误码翻译成可读信息 */
function wrap(name, fn) {
  return async (_event, ...args) => {
    const started = Date.now();
    try {
      const out = await fn(...args);
      console.log(`[ipc] ${name} ✓ ${Date.now() - started}ms`);
      return out;
    } catch (e) {
      const { code, msg } = describeError(e);
      console.error(`[ipc] ${name} ✗ ${Date.now() - started}ms  ${code ? `[${code}] ` : ''}${msg}`);
      const err = new Error(code ? `[${code}] ${msg}` : msg);
      err.code = code;
      throw err;
    }
  };
}

function registerIpc() {
  const c = () => getClient();

  /*
   * 退出登录。
   * logout() 只清内存里的 session，落盘由 onSessionChange 那个回调负责 ——
   * 所以这里**不要自己删文件**，删了反而和回调打架。
   */
  ipcMain.handle('account:logout', async () => {
    try {
      const c = await getClient();
      c.logout();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  /* ------------------------------------------------------------------ */
  /* 歌手 / 专辑详情                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * 专辑歌曲是**嵌套**结构（base / audio_info / album_info / authors），
   * 跟别的接口的扁平结构不一样，所以要单独摊平。
   *
   * 这些字段名是探针打出来的真实结构，不是猜的：
   *   base.audio_name / base.album_id / base.album_audio_id / base.author_name
   *   audio_info.hash / audio_info.duration（毫秒）
   *   album_info.album_name / album_info.cover（含 {size} 占位符）
   *   authors[0].author_id / authors[0].author_name
   */
  function mapNestedSong(item) {
    const base = item.base || {};
    const ai = item.audio_info || {};
    const al = item.album_info || {};
    const authors = Array.isArray(item.authors) ? item.authors : [];
    // 封面里带 {size} 占位符，替换成实际尺寸
    const cover = String(al.cover || '').replace('{size}', '480');
    return {
      hash: String(ai.hash || ''),
      name: String(base.audio_name || '').replace(/<[^>]+>/g, ''),
      artist: String(base.author_name || (authors[0] && authors[0].author_name) || ''),
      albumId: Number(base.album_id) || 0,
      albumName: String(al.album_name || ''),
      albumAudioId: Number(base.album_audio_id) || 0,
      mixSongId: Number(base.album_audio_id) || 0,
      artistId: Number((authors[0] && authors[0].author_id) || 0) || 0,
      durationSec: ai.duration ? Math.round(Number(ai.duration) / 1000) : 0,
      privilege: Number(item.copyright && item.copyright.privilege) || 0,
      cover,
      hqHash: String(ai.hash_320 || ''),
      sqHash: String(ai.hash_flac || ''),
    };
  }

  ipcMain.handle(
    'artist:detail',
    wrap('artist:detail', async (artistId) => {
      const c = await getClient();
      const raw = await c.getArtistDetail(artistId);
      if (!raw) return { ok: true, data: null };
      return {
        ok: true,
        data: {
          artistId: Number(raw.author_id) || Number(artistId) || 0,
          name: String(raw.author_name || ''),
          avatar: String(raw.sizable_avatar || raw.avatar || '').replace('{size}', '480'),
          intro: String(raw.long_intro || raw.intro || ''),
          songCount: Number(raw.song_count) || 0,
          albumCount: Number(raw.album_count) || 0,
          fans: Number(raw.fansnums) || 0,
        },
      };
    })
  );

  ipcMain.handle(
    'artist:songs',
    wrap('artist:songs', async (artistId, page = 1, pagesize = 30) => {
      const c = await getClient();
      const list = await c.getArtistSongs(artistId, { page, pagesize });
      // 扁平的，直接走 mapSong
      return { ok: true, songs: list.map(mapSong) };
    })
  );

  ipcMain.handle(
    'album:detail',
    wrap('album:detail', async (albumId) => {
      const c = await getClient();
      const raw = await c.getAlbumDetail(albumId);
      if (!raw) return { ok: true, data: null };
      return {
        ok: true,
        data: {
          albumId: Number(raw.album_id) || Number(albumId) || 0,
          name: String(raw.album_name || ''),
          artist: String(raw.author_name || ''),
          cover: String(raw.sizable_cover || raw.cover || '').replace('{size}', '480'),
          intro: String(raw.intro || ''),
          publishDate: String(raw.publish_date || ''),
        },
      };
    })
  );

  ipcMain.handle(
    'album:songs',
    wrap('album:songs', async (albumId, page = 1, pagesize = 50) => {
      const c = await getClient();
      const r = await c.getAlbumSongs(albumId, { page, pagesize });
      return { ok: true, total: r.total, songs: r.songs.map(mapNestedSong) };

    })
  );

  ipcMain.handle(
    'account',
    /*
     * 账号信息。注意用的是 wrap('account', ...) —— 那个包装负责统一错误处理，
     * 新加的 handler 也应该照这个来，别自己另起一套 try/catch 风格。
     */
    wrap('account', async () => {
      const cli = c();
      if (!cli.isLoggedIn) return { loggedIn: false };
      try {
        const res = await cli.call('user_detail');
        const u = (res.body && res.body.data) || {};
        return {
          loggedIn: true,
          nickname: pick(u, 'nickname', 'k_nickname', 'UserName') || '',
          userid: String(cli.session.userid || ''),
          pic: pick(u, 'pic', 'k_pic') || '',
          vipLevel: Number(pick(u, 'vip_type') || 0) > 0 ? 'VIP' : '普通用户',
        };
      } catch {
        return { loggedIn: true, userid: String(cli.session.userid || ''), vipLevel: '普通用户' };
      }
    })
  );

  /*
   * 下列几个接口都是"我自己的数据"，未登录时不该发出去。
   *
   * 原因：核心库的这些模块在缺少凭据时会退化成默认值
   * （user_history 里是 userid=0、token=''），带着这种参数请求，
   * 服务端会回 [20010] invalid param。于是界面拿到的不是空列表
   * 而是一个报错，未登录的新用户一进来就看到「加载失败」。
   *
   * 直接返回空数组：省掉一次注定失败的请求，界面也能自然地显示
   * 「还没有播放记录」，而不是把错误糊到脸上。
   */
  const requireLogin = (fn) => async (...args) => {
    if (!c().isLoggedIn) return [];
    return fn(...args);
  };

  ipcMain.handle(
    'playlists',
    wrap('playlists', requireLogin(async () => {
      const res = await c().getUserPlaylists({ page: 1, pagesize: 100 });
      const data = (res.body && res.body.data) || {};
      const list = data.info || data.list || data.lists || [];
      return list.map(mapPlaylist).filter((p) => p.id);
    }))
  );

  /* ---- 最近播放 ---- */
  ipcMain.handle(
    'history',
    wrap('history', requireLogin(async (page = 1) => {
      const res = await c().getUserHistory({ page: Number(page) || 1, pagesize: 100 });
      const body = res.body || {};
      const data = body.data || body;
      const list = data.songs || data.info || data.lists || data.list || [];
      /*
       * ★ 历史记录的每一项是**包装对象**，真正的歌在 info 里：
       *   { mxid, ot, pc, op, sr, info: { name, hash, singername, mixsongid, ... } }
       * 直接 mapSong(item) 得到的是一首空歌（字段全读不到），
       * 再被 .filter(s => s.hash) 全部滤掉 —— 表现就是
       * "接口明明有数据，列表却是空的"。这是打原始返回才看出来的，
       * 光猜字段名猜不到这一层。
       */
      return (Array.isArray(list) ? list : [])
        .map((it) => mapSong(it && it.info ? it.info : it))
        .filter((s) => s.hash);
    }))
  );

  /*
   * ---- 播放历史上报 ----
   *
   * 上报失败不该影响播放，所以这里**吞掉异常并返回 ok:false**，
   * 而不是抛给渲染进程 —— 界面上的 await 也就不需要包 try。
   */
  ipcMain.handle(
    'historyUpload',
    wrap('historyUpload', async (mxid) => {
      // 未登录时上报没有意义（userid 会退化成 0），直接说清楚原因，
      // 不要带一份无效参数去换一个 [20010]
      if (!c().isLoggedIn) return { ok: false, reason: 'not-logged-in' };
      const id = Number(mxid);
      if (!Number.isFinite(id) || id <= 0) return { ok: false, reason: 'no-mxid' };
      try {
        await c().uploadPlayHistory({ mxid: id });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e && e.message) || String(e) };
      }
    })
  );

  /* ---- 私人 FM ---- */
  ipcMain.handle(
    'personalFm',
    // 个性化推荐，未登录时 userid 会退化成 0，同样会拿回 [20010]
    wrap('personalFm', requireLogin(async () => {
      const res = await c().getPersonalFm();
      const body = res.body || {};
      /*
       * ★ FM 的歌曲在 data.song_list 里（实测），不是 songs/info/lists。
       * data 是个对象，键包括 song_list / hotsong_num / sync_point / mode 等。
       */
      const raw = body.data;
      const list = Array.isArray(raw)
        ? raw
        : (raw && (raw.song_list || raw.songs || raw.info || raw.lists || raw.list)) || [];
      return (Array.isArray(list) ? list : [])
        .map((it) => mapSong(it && it.info ? it.info : it))
        .filter((s) => s.hash);
    }))
  );

  ipcMain.handle(
    'playlistTracks',
    wrap('playlistTracks', async (id) => {
      const out = [];
      for (let page = 1; page <= 3; page++) {
        const res = await c().getPlaylistTracks(id, { page, pagesize: 100 });
        const data = (res.body && (res.body.data || res.body)) || {};
        const songs = data.songs || data.info || data.lists || data.list || data.audios || [];
        if (!Array.isArray(songs) || songs.length === 0) break;
        out.push(...songs.map(mapSong));
        if (songs.length < 100) break;
      }
      return out.filter((s) => s.hash);
    })
  );

  /*
   * ---- 歌单增删改 ----
   *
   * 写操作全在主进程：登录态（token / userid）在这里，而且这几个接口
   * 带签名和 AES 加密，不能拿到渲染进程去。
   *
   * 四个都返回接口的原始 body —— 酷狗这几个接口的返回结构不太统一
   * （有的在 body.data，有的直接 body.status），与其在这里猜，
   * 不如把判断交给界面，同时一律**要求界面改完重新拉一次列表**，
   * 避免本地状态和服务器不一致。
   */
  ipcMain.handle(
    'playlistCreate',
    wrap('playlistCreate', async (name, isPrivate) => {
      const clean = String(name || '').trim();
      if (!clean) throw new Error('歌单名不能为空');
      if (clean.length > 40) throw new Error('歌单名太长（最多 40 字）');
      const res = await c().createPlaylist(clean, isPrivate ? 1 : 0);
      return { ok: true, body: (res && res.body) || null };
    })
  );

  ipcMain.handle(
    'playlistDelete',
    wrap('playlistDelete', async (listid) => {
      if (!listid) throw new Error('缺少歌单 id');
      const res = await c().deletePlaylist(listid);
      return { ok: true, body: (res && res.body) || null };
    })
  );

  ipcMain.handle(
    'playlistAddTracks',
    wrap('playlistAddTracks', async (listid, songs) => {
      if (!listid) throw new Error('缺少歌单 id');
      if (!Array.isArray(songs) || !songs.length) throw new Error('没有选中歌曲');
      // 加歌要的是 name / hash / albumId / mixSongId —— 界面直接传 mapSong 的产物即可
      const res = await c().addPlaylistTracks(listid, songs);
      return { ok: true, body: (res && res.body) || null };
    })
  );

  ipcMain.handle(
    'playlistRemoveTracks',
    wrap('playlistRemoveTracks', async (listid, fileIds) => {
      if (!listid) throw new Error('缺少歌单 id');
      if (!Array.isArray(fileIds) || !fileIds.length) throw new Error('没有选中歌曲');
      const res = await c().removePlaylistTracks(listid, fileIds);
      return { ok: true, body: (res && res.body) || null };
    })
  );

  ipcMain.handle(
    'search',
    /*
     * 搜索结果分页。
     *
     * 原先把 pagesize 写死 30，于是"搜索只能显示 30 条" —— 而接口本身
     * 实测允许 pagesize=100（返回 100 条），并且 page=2/3 都能正常翻。
     * 现在把 page / pagesize 从界面透传下来，界面负责"加载更多"。
     */
    wrap('search', async (kw, page, pagesize) => {
      const res = await c().search(kw, {
        page: Number(page) || 1,
        pagesize: Number(pagesize) || 50,
      });
      return {
        songs: res.songs.map(mapSong).filter((s) => s.hash),
        total: res.total || 0,
        page: res.page || 1,
        pagesize: res.pagesize || 0,
      };
    })
  );

  ipcMain.handle(
    'stream',
    wrap('stream', async (song, quality) => {
      console.log(
        `[取流] 收到歌曲="${song.name}"  hash=${song.hash}  albumAudioId=${song.albumAudioId}  音质=${quality || 128}`
      );
      const info = await c().getSongStream({
        hash: song.hash,
        albumId: song.albumId,
        albumAudioId: song.albumAudioId,
        quality: quality || 128,
      });
      return {
        url: info.url,
        restricted: info.restricted,
        failProcess: info.failProcess || [],
        source: info.source,
        durationMs: info.durationMs,
      };
    })
  );

  ipcMain.handle(
    'lyric',
    wrap('lyric', async (song) => {
      const ly = await c().getLyric({ name: song.name, artist: song.artist, hash: song.hash });
      return { ok: ly.ok, text: ly.text, isWordByWord: ly.isWordByWord, format: ly.format };
    })
  );

  // ---- 首页数据 ----
  ipcMain.handle(
    'recommend',
    wrap('recommend', async () => {
      const res = await c().call('everyday_recommend', { page: 1, pagesize: 30 });
      const data = (res.body && res.body.data) || {};
      const list = data.songs || data.info || data.list || data.lists || [];
      return Array.isArray(list) ? list.map(mapSong).filter((s) => s.hash) : [];
    })
  );

  ipcMain.handle(
    'ranks',
    wrap('ranks', async () => {
      const res = await c().call('rank_list', {});
      const info = (res.body && res.body.data && res.body.data.info) || [];
      if (!Array.isArray(info)) return [];
      return info
        .filter((r) => r && (r.rankid || r.rank_id))
        .slice(0, 14)
        .map((r) => ({
          id: r.rankid || r.rank_id,
          name: String(r.rankname || r.rank_name || '榜单'),
          cover: String(r.album_img_9 || r.img_9 || r.banner_9 || '').replace('{size}', '240'),
          playTimes: Number(r.play_times) || 0,
        }));
    })
  );

  ipcMain.handle(
    'rankTracks',
    wrap('rankTracks', async (rankId) => {
      const res = await c().call('rank_audio', { rankid: rankId, page: 1, pagesize: 100 });
      const data = (res.body && res.body.data) || {};
      const list = data.info || data.songs || data.list || data.audio || data.lists || [];
      const arr = Array.isArray(list) ? list : Array.isArray(data) ? data : [];
      return arr.map(mapSong).filter((s) => s.hash);
    })
  );

  // ---- 喜欢 / 收藏 ----
  ipcMain.handle(
    'favoriteHashes',
    wrap('favoriteHashes', async () => {
      const set = await c().getFavoriteHashes();
      return Array.from(set);
    })
  );

  ipcMain.handle(
    'like',
    wrap('like', async (song) => {
      await c().addToFavorites(song);
      return { ok: true, liked: true };
    })
  );

  ipcMain.handle(
    'unlike',
    wrap('unlike', async (song) => {
      // 优先用 fileid；没有就传 hash 让核心去反查
      await c().removeFromFavorites(song.fileId || song.hash);
      return { ok: true, liked: false };
    })
  );

  // ---- 窗口控制（无边框窗口需要界面自己提供最小化/最大化/关闭）----


/* ------------------------------------------------------------------ */
/* 全局自定义热键                                                      */
/* ------------------------------------------------------------------ */

/** accelerator -> action。用于整表解绑，也用于排查"这个键绑给谁了"。 */
const registeredGlobalHotkeys = new Map();

function sendGlobalHotkeyAction(action) {
  if (!mainWindow || mainWindow.isDestroyed() || !action) return;
  mainWindow.webContents.send('hotkeys:action', { action });
}

function unregisterAllGlobalHotkeys() {
  for (const acc of registeredGlobalHotkeys.keys()) {
    try {
      globalShortcut.unregister(acc);
    } catch {}
  }
  registeredGlobalHotkeys.clear();
}

/**
 * 用整张绑定表重配全局热键，逐条返回结果。
 *
 * 为什么是"整表重来"而不是增量更新：增量的代价是每次改动都要算差集，
 * 而差集算错会留下"已经不该存在的热键还在生效"——那种 bug 很隐蔽
 *（按键还有反应，但界面上已经没这条了）。全解绑再全注册，逻辑只有一条路径。
 */
function configureGlobalHotkeys(bindings) {
  unregisterAllGlobalHotkeys();
  const results = [];
  const seen = new Set();
  for (const item of Array.isArray(bindings) ? bindings : []) {
    const action = item && String(item.action || '').trim();
    const accelerator = item && String(item.accelerator || '').trim();
    if (!action || !accelerator) continue;
    // 同一个组合只能绑一个动作，后面的丢掉（否则注册必然失败，还会报成"被占用"）
    if (seen.has(accelerator)) {
      results.push({ action, accelerator, ok: false, reason: 'duplicate' });
      continue;
    }
    seen.add(accelerator);
    let ok = false;
    let apiError = null;
    try {
      ok = globalShortcut.register(accelerator, () => sendGlobalHotkeyAction(action));
    } catch (err) {
      /*
       * ★ 这里必须把异常和"注册失败"分开。
       *
       * 我第一版写的是 catch { ok = false }，于是当 globalShortcut
       * **根本没被 import** 时（ReferenceError），每一条都被报成"被占用" ——
       * 界面上会显示"6 条全被占用"，而真相是代码没接上。
       * 一个吞掉异常、又给出一个具体但错误的归因的 catch，
       * 比直接报错危险得多。
       */
      apiError = String((err && err.message) || err);
      console.error('[热键] 注册 ' + accelerator + ' 时接口异常：' + apiError);
    }
    if (ok) {
      registeredGlobalHotkeys.set(accelerator, action);
      results.push({ action, accelerator, ok: true });
    } else {
      // 注册失败几乎只有一种原因：被系统或别的软件占用了
      results.push({
        action,
        accelerator,
        ok: false,
        reason: apiError ? 'api-error' : 'taken',
        apiError,
        conflict: { sourceName: '系统 / 其他软件' },
      });
    }
  }
  console.log(
    '[热键] 已注册 ' + registeredGlobalHotkeys.size + ' 条，失败 ' +
      results.filter((r) => !r.ok).length + ' 条'
  );
  return results;
}

ipcMain.handle('hotkeys:configure', (_e, bindings) => configureGlobalHotkeys(bindings));
ipcMain.handle('hotkeys:list', () => Array.from(registeredGlobalHotkeys.entries()));


  /* ---- 桌面歌词 ---- */
  ipcMain.handle('lyric:toggle', (_e, on) => showLyricWindow(on));
  ipcMain.handle('lyric:push', (_e, payload) => {
    pushLyric(payload);
    return true;
  });
  ipcMain.handle('lyric:toggleLock', () => setLyricLock(!lyricLocked));
  ipcMain.handle('lyric:setLock', (_e, on) => setLyricLock(on));
  /*
   * 按文字尺寸收缩窗口。
   *
   * 保持**中心不动**：加 padding 的时候如果锚在左上角，
   * 字会随着窗口一起挪，看起来像在跳。
   *
   * 夹一个下限 —— 歌词为空时量出来可能是 0 宽，窗口缩成一条线就再也拖不到了。
   */
  /*
   * 接收"文字的实际范围"（相对窗口左上角）。
   *
   * ★ 注意这里**不改窗口尺寸** —— 窗口是固定的。
   * 这个矩形只用来判断"光标是不是在歌词上"，从而决定要不要穿透。
   * 我原来在这里 setBounds 把窗口贴合文字，方向是错的：
   * 量不准会裁字，而且越量越乱。学 Mineradio 之后这条路就不需要了。
   */
  ipcMain.handle('lyric:diag', (_e, d) => {
    const wb = lyricWindow && !lyricWindow.isDestroyed() ? lyricWindow.getBounds() : null;
    console.log('[桌面歌词·诊断] 页面视口', JSON.stringify(d), '窗口', wb ? wb.width + 'x' + wb.height : '?');
    return true;
  });
  /*
   * 拖动：页面算好位移差值，这里挪窗口。
   *
   * 为什么不让系统拖（-webkit-app-region: drag）：
   * 那样页面收不到鼠标事件（中键就废了），而且拖动时会看到系统的拖拽边框。
   * 自己拖之后这两个问题一起消失。
   *
   * 用 setBounds 而不是 setPosition：Windows 上窗口一多，
   * setPosition 在多显示器/缩放场景下偶尔会把窗口弹回去，
   * setBounds 给全量几何更稳。
   */
  /*
   * 拖动：页面算好位移差值，这里挪窗口。
   *
   * ★ 这里**只挪窗口**，别的什么都不做。
   * 原来还顺手调了 applyLyricMouseBehavior（查光标 + 可能改穿透）和
   * scheduleSaveLyricBounds（重置写盘定时器）—— 这两个都是每次 mousemove
   * 都要跑的重活，是卡顿的主要来源。
   * 穿透校准改由松手时的 dragEnd 做一次；写盘也在那时做一次。
   */
/*
   * 合并位移，每帧最多真正移动窗口一次。
   *
   * 实测 setBounds 要 9.31ms，而拖动时鼠标每秒能发几百个 pointermove ——
   * 逐个处理的话主进程根本追不上，IPC 排队之后窗口就会"攒一批一起冲"。
   *
   * 24ms：实测每次移动要 9.17ms，16ms 合并（62 次/秒）仍要占主进程七成；
   * 放宽到 24ms（约 42 次/秒、占用降到三成）才留得出余量。
   *
   * 位移是**累加**的，所以窗口最终一定落在精确的位置上 ——
   * 这不是"丢弃式节流"，只是把碎步合并成整步。
   */
  /*
   * ★ 拖动：**不移动窗口**，把位移转发给页面，由它改内容的 transform。
   *
   * 这是实测之后唯一走得通的做法：
   *   Win32 直接移动窗口        3.68ms
   *   Electron setPosition      10.5ms（加了 focusable:false 之后）
   *   而拖动每秒要移动上百次 → 主进程必然被占满，手感就是"不跟手"
   * 这个开销在 Electron 层面绕不过去，所以改成"窗口铺满屏幕、永远不动"，
   * 拖动只改内容的 transform —— GPU 合成，几乎免费。
   */
  ipcMain.handle('lyric:moveBy', (_e, dx, dy) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return false;
    lyricWindow.webContents.send('lyric:move', { dx: Number(dx) || 0, dy: Number(dy) || 0 });
    dragStats.moves++;
    return true;
  });

  /** 页面把当前内容偏移报回来，用于落盘 */
  ipcMain.handle('lyric:offset', (_e, off) => {
    if (!off) return false;
    lyricOffsetX = Number(off.x) || 0;
    lyricOffsetY = Number(off.y) || 0;
    scheduleSaveLyricBounds();
    return true;
  });


  /** 开始拖动：先冻结穿透判定，否则第一下移动就可能把窗口切成穿透 */
  ipcMain.handle('lyric:dragStart', () => {
    if (lyricWindow && !lyricWindow.isDestroyed()) {
      lyricWindow.webContents.send('lyric:offset', { x: lyricOffsetX, y: lyricOffsetY });
    }
    lyricDragging = true;
    // 重新同步位置基准：窗口可能被别处（拖到别的显示器、系统缩放变化）挪过
    lyricPosX = null;
    lyricPosY = null;
    dragStats.starts++;
    return true;
  });

  /**
   * 结束拖动：解冻、校准一次穿透、位置落盘一次。
   *
   * ★ 这里**不能**把 lyricMouseIgnored 清成 null。
   *
   * 清了就等于"强制重算"，于是每次松手（哪怕只是一次没移动的单击）
   * 都会调用一次 setIgnoreMouseEvents —— 而 Windows 上切换这个标志
   * 会让分层窗口重绘一次。用户看到的就是"点一下像被弹出来一下"。
   *
   * 保留缓存、交给 applyLyricMouseBehavior 自己比较：
   * 需要变就变，不需要变就一次系统调用都不发。
   */
  ipcMain.handle('lyric:dragEnd', () => {
    // 收尾前把还没应用的位移补上，否则松手时最后几像素会丢
    if (pendingMoveTimer) {
      clearTimeout(pendingMoveTimer);
      applyPendingLyricMove();
    }
    lyricDragging = false;
    dragStats.ends++;
    applyLyricMouseBehavior();
    scheduleSaveLyricBounds();
    return true;
  });

  /*
   * 移动窗口的基准测试。
   *
   * 拖动卡顿我一直没法自己测（按不住鼠标），但"移动一次窗口要多久"
   * 是可以脱离拖动单独测的 —— 连续移动 40 次，量每次耗时，报告分布。
   *
   * 用 performance.now()（亚毫秒）而不是 Date.now()：
   * Windows 上后者的分辨率是 15.6ms，对不到 1ms 的操作取样平均，
   * 会得到 5~10ms 这种**纯量化噪声**构成的"耗时" —— 我上一轮就是被它骗了。
   */
  ipcMain.handle('lyric:bench', async (_e, n) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return { error: 'NO_WINDOW' };
    const count = Math.max(1, Math.min(200, Number(n) || 40));

    const run = () => {
      const base = lyricWindow.getBounds();
      const samples = [];
      for (let i = 0; i < count; i++) {
        const t0 = performance.now();
        lyricWindow.setPosition(base.x + (i % 20), base.y);
        samples.push(performance.now() - t0);
      }
      lyricWindow.setPosition(base.x, base.y);
      samples.sort((a, b) => a - b);
      const sum = samples.reduce((a, b) => a + b, 0);
      return {
        avg: +(sum / count).toFixed(3),
        min: +samples[0].toFixed(3),
        p50: +samples[Math.floor(count / 2)].toFixed(3),
        max: +samples[count - 1].toFixed(3),
      };
    };

    /*
     * ★ 三态对比，把"贵在哪"彻底分开。
     *
     *   隐藏时   —— 窗口不可见就没有合成成本，这是移动窗口的**下限**
     *   正常时   —— 现状
     *   极简时   —— 停掉 canvas 粒子、去掉辉光 filter
     *
     * 判读：
     *   隐藏也贵            → 和页面无关，是窗口本身的属性（透明/置顶）在收税
     *   正常贵、极简便宜    → 贵在**页面重绘** → 解法是拖动期间让页面极简
     *   三者都贵            → 是 setPosition 这条路本身的同步开销
     */
    lyricWindow.hide();
    await new Promise((r) => setTimeout(r, 150));
    const hidden = run();
    lyricWindow.showInactive();
    await new Promise((r) => setTimeout(r, 250));

    const normal = run();

    let minimal = null;
    try {
      await lyricWindow.webContents.executeJavaScript("document.body.classList.add('minimal'); 'ok'");
      await new Promise((r) => setTimeout(r, 350));
      minimal = run();
      await lyricWindow.webContents.executeJavaScript("document.body.classList.remove('minimal'); 'ok'");
    } catch (e) {
      minimal = { error: (e && e.message) || String(e) };
    }

    return { n: count, hidden, normal, minimal };
  });

  ipcMain.handle('lyric:hotBounds', (_e, rect) => {
    if (!rect || !Number.isFinite(rect.left)) return false;
    lyricHotBounds = {
      left: Number(rect.left) || 0,
      top: Number(rect.top) || 0,
      right: Number(rect.right) || 0,
      bottom: Number(rect.bottom) || 0,
    };
    lyricMouseIgnored = null; // 热点变了要立刻重算
    applyLyricMouseBehavior();
    return true;
  });

  ipcMain.handle('lyric:locked', () => lyricHardLock);
  ipcMain.handle('lyric:visible', () => !!(lyricWindow && !lyricWindow.isDestroyed() && lyricWindow.isVisible()));

  ipcMain.handle('win:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('win:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });

  ipcMain.handle('win:close', () => {
    /*
     * 界面右上角的 ✕ 改成"收进托盘"，不退出。
     * 这是托盘应用的标准行为：✕ 只是收起来，真要退出走托盘菜单或 Alt+F4 之外的方式。
     * 第一次收起来时给个气泡提示，否则用户会以为程序被自己关掉了。
     */
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!tray) {
      mainWindow.close();
      return;
    }
    mainWindow.hide();
    if (!closeHintShown && tray && typeof tray.displayBalloon === 'function') {
      closeHintShown = true;
      try {
        tray.displayBalloon({
          title: '音乐播放器还在运行',
          content: '已经收进托盘，点击托盘图标可以重新打开；退出请用托盘菜单里的「退出」。',
        });
      } catch {}
    }
  });

  // ---- 扫码登录 ----
  let activeQrKey = '';

  ipcMain.handle(
    'loginQrCreate',
    wrap('loginQrCreate', async () => {
      const cli = c();
      const keyRes = await cli.loginQrKey();
      const key = (keyRes.body && keyRes.body.data && keyRes.body.data.qrcode) || '';
      if (!key) throw new Error('酷狗没有返回二维码 key');

      const createRes = await cli.loginQrCreate(key, true);
      const data = (createRes.body && createRes.body.data) || {};
      activeQrKey = key;

      return {
        key,
        url: data.url || '',
        image: data.base64 || '',
      };
    })
  );

  ipcMain.handle(
    'loginQrCheck',
    wrap('loginQrCheck', async (key) => {
      const cli = c();
      const res = await cli.loginQrCheck(key || activeQrKey);
      const data = (res.body && res.body.data) || {};
      const status = Number(data.status);

      // status 4 = 授权成功，core 已把 token/userid 并入 session 并落盘
      return { status, loggedIn: status === 4 && cli.isLoggedIn };
    })
  );
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

let mainWindow = null;

/* ------------------------------------------------------------------ */
/* 窗口位置记忆                                                        */
/* ------------------------------------------------------------------ */

const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

/**
 * 读回上次的窗口位置。
 *
 * ★ 坐标必须拿**当前显示器列表**验一遍才能用。
 * 用户可能拔了显示器 / 改了分辨率，旧坐标会落在已经不存在的屏幕上 ——
 * 那种情况下窗口其实是开着的，只是画在看不见的地方，用户看到的是"打不开"。
 * 尺寸可以保留（任何屏幕都放得下），位置要丢掉、让它回到默认居中。
 */
function loadWindowState() {
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'));
  } catch {
    return null;
  }
  if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return null;

  const w = Math.max(860, Math.round(s.width));
  const h = Math.max(560, Math.round(s.height));
  if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return { width: w, height: h };

  let visible = false;
  try {
    // screen 只能在 app ready 之后用，而 createWindow 就是在 ready 里调的
    visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x < b.x + b.width && s.x + w > b.x && s.y < b.y + b.height && s.y + h > b.y;
    });
  } catch {
    visible = false;
  }
  return visible ? { x: Math.round(s.x), y: Math.round(s.y), width: w, height: h } : { width: w, height: h };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    /*
     * 最大化时 getBounds 给的是最大化后的框 —— 直接存下来，
     * 下次恢复会变成一个"铺满屏幕的普通窗口"而不是最大化的窗口。
     * 所以要分开记：普通状态存 getNormalBounds，另外记一个 maximized。
     */
    /*
     * 窗口铺满屏幕、永远不动，所以要存的是**内容偏移**。
     * 兼容旧格式：老文件里存的是窗口坐标，读出来当作"默认居中所用的输入"。
     */
    const b = { x: lyricOffsetX, y: lyricOffsetY, isOffset: true };
    fs.writeFileSync(
      WINDOW_STATE_FILE(),
      JSON.stringify({ ...b, maximized: mainWindow.isMaximized() })
    );
  } catch (e) {
    /*
     * 写不进去不该影响使用，所以不抛 —— 但**必须留一条痕迹**。
     *
     * 我第一版写的是空的 catch{}，结果"窗口位置记不住"这件事
     * 在日志里一点线索都没有，只能靠猜。只报一次，避免刷屏。
     *（开发环境常见成因：沙箱禁止写 %APPDATA%、磁盘满、权限不足。）
     */
    if (!windowStateWarned) {
      windowStateWarned = true;
      console.warn('[窗口] 位置记忆写盘失败，本窗口不再重试：', (e && e.message) || e);
    }
  }
}

/** 拖动 / 缩放时不要每帧都写盘 —— 节流到停下来 400ms 之后写一次 */
let windowStateTimer = null;
/** 写盘失败只报一次，避免每 400ms 刷一条 */
let windowStateWarned = false;
function scheduleSaveWindowState() {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(saveWindowState, 400);
}

/* ------------------------------------------------------------------ */
/* 桌面歌词（独立置顶窗口）                                            */
/* ------------------------------------------------------------------ */

const LYRIC_STATE_FILE = () => path.join(app.getPath('userData'), 'lyric-window.json');
/*
 * 窗口是一块**固定的大区域**，不是"贴合文字"的小框。
 *
 * 学自 Mineradio（desktop/main.js:3544）：它按屏幕比例取
 * min(max(880, 屏宽*0.72), 屏宽-96)。固定大小的好处是
 * **长句永远不会被裁** —— 而"贴合文字"那条路我走过，
 * 量不准（系统文本缩放会让实际渲染比测量值大），最后把文件都写坏了。
 *
 * 至于"大框会挡鼠标"：那不是靠尺寸解决的，靠下面的动态穿透。
 */
/*
 * ★ 窗口铺满显示器工作区，**拖动时它一动不动**。
 *
 * 原来窗口只有 900x190、跟着鼠标走 —— 而实测 Electron 移动一次窗口要 10.5ms，
 * 拖动时每秒要移动上百次，主进程必然被占满，手感就是"不跟手"。
 * 铺满之后，拖动只改内容的 transform（GPU 合成，几乎免费）。
 */
const LYRIC_W = 900;
const LYRIC_H = 190;

/** 歌词窗口铺满哪块屏幕（用主屏的工作区，避开任务栏） */
function lyricFullBounds() {
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  } catch {
    return { x: 0, y: 0, width: LYRIC_W, height: LYRIC_H };
  }
}

let lyricWindow = null;
/** 文字在窗口内的实际范围（由歌词窗口量好报上来），null 表示整窗都算热点 */
let lyricHotBounds = null;
/** 当前是否处于"整窗穿透"状态，避免重复调 setIgnoreMouseEvents */
let lyricMouseIgnored = null;
/** 用户手动锁定的穿透（锁定后无论光标在哪都穿透） */
let lyricHardLock = false;
let lyricMousePoller = null;
/** 鼠标穿透（锁定）状态。穿透后窗口不再接收任何鼠标事件。 */
let lyricLocked = false;

/** 内容偏移（相对窗口左上角）。窗口铺满屏幕，位置全靠这个 */
let lyricOffsetX = 0;
let lyricOffsetY = 0;
/** 首次显示时页面会来要初始偏移 */
let lyricOffsetReady = false;
/** 诊断计数：applyLyricMouseBehavior 被调用了多少次（判断轮询是否还活着） */
const probeCalls = { applyBehavior: 0 };

function loadLyricBounds() {
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(LYRIC_STATE_FILE(), 'utf8'));
  } catch {
    return null;
  }
  if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return null;
  // 和主窗口一样的道理：显示器可能被拔掉，旧坐标要验一遍
  try {
    const ok = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x < b.x + b.width && s.x + LYRIC_W > b.x && s.y < b.y + b.height && s.y + LYRIC_H > b.y;
    });
    if (!ok) return null;
  } catch {
    return null;
  }
  return { x: Math.round(s.x), y: Math.round(s.y) };
}

/** 没存过位置时：屏幕底部居中、离任务栏一点距离 —— 这是桌面歌词最常见的位置 */
function defaultLyricBounds() {
  try {
    const b = screen.getPrimaryDisplay().workArea;
    return { x: Math.round(b.x + (b.width - LYRIC_W) / 2), y: Math.round(b.y + b.height - LYRIC_H - 56) };
  } catch {
    return { x: 200, y: 600 };
  }
}

let lyricSaveTimer = null;
function scheduleSaveLyricBounds() {
  if (lyricSaveTimer) clearTimeout(lyricSaveTimer);
  lyricSaveTimer = setTimeout(() => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return;
    try {
      fs.writeFileSync(LYRIC_STATE_FILE(), JSON.stringify(lyricWindow.getBounds()));
    } catch (e) {
      console.warn('[桌面歌词] 位置存不下来：', (e && e.message) || e);
    }
  }, 400);
}

/** 把穿透状态同时应用到窗口和页面（页面要显示"已锁定"提示） */
/**
 * **唯一的**锁定状态写入口。
 *
 * 为什么必须唯一：这个状态有多个可能来源（UI 按钮、热键、中键），
 * 之前每个来源各自写一次 lyricLocked，结果一次物理按键被切了两次，
 * 表现就是"按下去没反应"。状态这种东西只留一个写入口，
 * 是避免这类互相抵消最直接的办法。
 */
function setLyricLock(on) {
  const next = !!on;
  if (next === lyricLocked) return lyricLocked; // 无变化就不重复应用（也避免重复打日志）

  /*
   * ★ 去抖放在**这里**，不在各个调用点。
   *
   * 起因：一次物理中键被切了两次（页面的 mousedown + 主进程的全局监听），
   * 用户看到的是"按下去提示词闪一下"。
   * 我原来把 300ms 去抖写在 onGlobalMiddleClick 里，**挡不住另一条路径**。
   *
   * 状态保护必须和状态本身放在一起 —— 分散在各个调用点，
   * 早晚会漏掉一条（这次就是）。
   */
  const now = Date.now();
  if (now - lastLockAt < 300) {
    console.log('[桌面歌词] 锁定切换被忽略：300ms 内重复触发');
    return lyricLocked;
  }
  lastLockAt = now;
  lyricLocked = next;
  applyLyricLock();
  console.log('[桌面歌词] 锁定 →', next ? '已锁定' : '已解锁');
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.webContents.send('lyric:lock', next);
  }
  return lyricLocked;
}

function applyLyricLock() {
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  /*
   * 锁定 = **硬锁**：无论光标在哪都穿透。
   *（不锁的时候是"光标在文字上就不穿透"，见 applyLyricMouseBehavior。）
   *
   * 锁定之后窗口收不到任何鼠标事件，连"双击解锁"都收不到 ——
   * 所以主界面上的「词」按钮是必须的第二个入口。
   */
  lyricHardLock = lyricLocked;
  lyricMouseIgnored = null; // 清掉缓存，强制重算
  applyLyricMouseBehavior();
  lyricWindow.webContents.send('lyric:lock', lyricLocked);
}

/**
 * 把"文字热点"换算成屏幕坐标。
 * 热点由歌词窗口量出（相对窗口左上角），这里加上窗口位置。
 */
function lyricHotBoundsOnScreen() {
  if (!lyricWindow || lyricWindow.isDestroyed()) return null;
  const wb = lyricWindow.getBounds();
  const rel = lyricHotBounds;
  if (!rel) return null;
  return {
    x: wb.x + rel.left,
    y: wb.y + rel.top,
    width: Math.max(1, rel.right - rel.left),
    height: Math.max(1, rel.bottom - rel.top),
  };
}

/**
 * 按光标位置决定要不要穿透。
 *
 * 这就是 Mineradio 的做法（main.js:3593）：
 *   锁定了        → 一直穿透
 *   光标在文字上  → 不穿透（可以拖、可以双击）
 *   光标不在文字上 → 穿透，鼠标照常点到底下的窗口
 *
 * 于是"窗口里那些透明的地方"不会挡任何东西 ——
 * 不需要为了不挡鼠标去把窗口缩小，也就不会裁到长句。
 */
/**
 * 把攒下来的位移一次性应用掉。
 *
 * 用 setPosition 而不是 setBounds：窗口尺寸从来不在这里变，
 * setPosition 少一层尺寸协商，比 setBounds 便宜。
 */
function applyPendingLyricMove() {
  pendingMoveTimer = null;
  if (!pendingMoveX && !pendingMoveY) return;
  const dx = pendingMoveX;
  const dy = pendingMoveY;
  pendingMoveX = 0;
  pendingMoveY = 0;
  if (!lyricWindow || lyricWindow.isDestroyed()) return;

  /*
   * ★ 位置在 JS 里自己记，不再每次 getBounds()。
   *
   * getBounds() 是一次跨进程的窗口查询，而拖动时每秒要问几十次。
   * 位置本来就摆在我们自己手上（每次移动后累加即可），没必要每步都去问系统。
   * 拖动开始时同步一次做基准，之后就靠累加；窗口被外部挪动时缓存作废。
   */
  if (lyricPosX == null) {
    const b = lyricWindow.getBounds();
    lyricPosX = b.x;
    lyricPosY = b.y;
  }
  lyricPosX = Math.round(lyricPosX + dx);
  lyricPosY = Math.round(lyricPosY + dy);

  /*
   * 用 performance.now() 而不是 Date.now() ——
   * Windows 上 Date.now() 的分辨率是 15.6ms，对亚毫秒操作取平均
   * 会得出 5~10ms 的假耗时（上一轮就是被它骗的）。
   */
  const t0 = performance.now();
  lyricWindow.setPosition(lyricPosX, lyricPosY);
  dragStats.moves++;
  dragStats.moveMs += performance.now() - t0;
}

function applyLyricMouseBehavior() {
  probeCalls.applyBehavior++;
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  /*
   * ★ 拖动期间不动穿透状态。
   *
   * 拖动时窗口在光标底下移动，判定随时可能得出"光标已经不在窗口里"，
   * 于是 setIgnoreMouseEvents(true) —— 窗口当场收不到鼠标事件，拖动断掉。
   * 用户看到的就是"一顿一顿"。拖动期间保持现状即可，松手后再校准。
   */
  if (lyricDragging) return;
  let shouldIgnore = true;
  if (!lyricHardLock) {
    const hot = lyricHotBoundsOnScreen();
    if (hot) {
      const p = screen.getCursorScreenPoint();
      const inside =
        p.x >= hot.x && p.x <= hot.x + hot.width && p.y >= hot.y && p.y <= hot.y + hot.height;
      shouldIgnore = !inside;
    } else {
      // 还没量到热点时，整窗都算可交互（否则用户一开始就拖不动它）
      shouldIgnore = false;
    }
  }
  if (lyricMouseIgnored === shouldIgnore) return;
  lyricMouseIgnored = shouldIgnore;
  // forward: true —— 穿透时事件要转给下层窗口，不然用户点桌面也没反应
  lyricWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true });
}

function startLyricMousePoller() {
  if (lyricMousePoller) return;
  /*
   * 80ms 一次。这个频率下用户感觉不到延迟，而 CPU 开销可以忽略
   *（getCursorScreenPoint 是一次轻量的系统调用，不像 Mineradio 那样要
   * 为检测中键另起一个进程）。
   */
  lyricMousePoller = setInterval(applyLyricMouseBehavior, 80);
}

function stopLyricMousePoller() {
  if (lyricMousePoller) {
    clearInterval(lyricMousePoller);
    lyricMousePoller = null;
  }
}

/* ------------------------------------------------------------------ */
/* 中键全局监听（用于锁定状态下也能解锁）                              */
/* ------------------------------------------------------------------ */

let middleClickProc = null;
/** 中键信号文件路径（子进程往里追加字节，我们轮询它的大小） */
let middleSignalPath = null;
let middleSignalSize = 0;
let middleSignalTimer = null;
/** 待应用的拖动位移（累加，不丢），见 applyPendingLyricMove */
let pendingMoveX = 0;
let pendingMoveY = 0;
let pendingMoveTimer = null;
/** 窗口位置的本地缓存（避免每步 getBounds）。null 表示需要重新同步 */
let lyricPosX = null;
let lyricPosY = null;

/** 正在被用户拖动。拖动期间必须冻结穿透判定，否则窗口一挪就被判成"光标不在上面"而穿透，拖动会断 */
let lyricDragging = false;
/** 拖动诊断统计，见 dragStats 的汇总日志 */
const dragStats = { starts: 0, ends: 0, moves: 0, moveMs: 0 };
/** 上一次中键生效的时间，用于去抖 */
let lastMiddleAt = 0;
/** 上一次**实际生效**的锁定切换时间，去抖用（见 setLyricLock） */
let lastLockAt = 0;

/*
 * 这段 PowerShell 只做一件事：把每次"中键按下"作为一行 MMB 打到 stdout。
 * 边沿检测（$down -and -not $prev）放在子进程里做 —— 主进程只要收事件，
 * 不用自己记上一次的状态，逻辑少一层。
 *
 * 40ms 轮询：手感上察觉不到延迟，CPU 占用可以忽略。
 */
const MIDDLE_CLICK_PS = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class MRMiddle {',
  '  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);',
  '}',
  '"@',
  // 信号文件：只往里追加字节，主进程轮询它的大小
  '$path = $env:MR_MIDDLE_SIGNAL',
  '$prev = $false',
  'while ($true) {',
  '  $down = (([MRMiddle]::GetAsyncKeyState(4) -band 0x8000) -ne 0)',
  '  if ($down -and -not $prev) {',
  '    try { Add-Content -LiteralPath $path -Value "x" -NoNewline -Encoding ascii } catch {}',
  '  }',
  '  $prev = $down',
  '  Start-Sleep -Milliseconds 40',
  '}',
].join('\n');

/**
 * 收到一次中键点击。
 *
 * ★ 判定范围是**整个歌词窗口**，不是文字热点。
 *
 * 原来用文字热点（实测 427x81，而窗口是 900x190），等于要求把中键
 * 像素级精准地点在字上，偏到窗口里空白处就不算 —— 用起来就是"按了没反应"。
 * 用户明确要"只用鼠标中间"，那个门槛就是设计失误。
 *
 * 放宽到窗口范围之后目标大了四倍多，同时仍然避开了那个副作用：
 * 中键是全局的，完全不判断的话，用户在浏览器里按中键（自动滚动）
 * 也会把歌词锁掉。
 */
function onGlobalMiddleClick() {
  if (!lyricWindow || lyricWindow.isDestroyed() || !lyricWindow.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  /*
   * ★ 判定必须用**文字热点**，不能用窗口范围。
   *
   * 窗口以前是 900x190，"光标在窗口内"是个有意义的判断。
   * 但它现在**铺满屏幕**了 —— 光标永远在窗口内，这个判断恒为真，
   * 于是**在桌面任何地方按中键都会切换歌词的锁定**
   *（包括在浏览器里按中键自动滚动）。
   *
   * 用户就是这么把自己锁上、然后"拖不动"的：锁上之后整窗穿透，
   * 鼠标一个字都点不到，连"拖"这个动作都发不出去。
   */
  const hot = lyricHotBoundsOnScreen();
  if (hot) {
    const inside =
      p.x >= hot.x && p.x <= hot.x + hot.width && p.y >= hot.y && p.y <= hot.y + hot.height;
    if (!inside) {
      /*
       * 被忽略时必须**留下原因**。
       * 这道判断会静默地把事件吃掉，而"按了没反应"和"功能没做"
       * 从外面看一模一样 —— 不打日志就只能靠猜。
       */
      console.log(
        '[桌面歌词] 中键被忽略：光标不在文字上。光标=(' + p.x + ',' + p.y + ') 热点=(' +
          Math.round(hot.x) + ',' + Math.round(hot.y) + ' ' +
          Math.round(hot.width) + 'x' + Math.round(hot.height) + ')'
      );
      return;
    }
  }
  /*
   * 去抖 300ms。
   *
   * 物理按键不可能在 300ms 内产生两次有效点击，所以这个阈值不会
   * 吞掉真实操作；但"多个监听进程各写一次信号文件"或"某处多触发一次"
   * 造成的连击，正好被它吃掉。
   */
  const now = Date.now();
  if (now - lastMiddleAt < 300) return; // 入口还有一道，这里只是少跑一次
  lastMiddleAt = now;
  setLyricLock(!lyricLocked);
}

function startMiddleClickWatcher() {
  if (process.platform !== 'win32' || middleClickProc) return;
  try {
    /*
     * 信号文件放在 userData 下。
     * 为什么不用 stdout 管道：沙箱下 spawn 的 pipe 抓不到子进程输出
     *（本项目环境说明里写明了这条），而 spawn 本身会成功、也不报错，
     * 表现就是"监听明明起来了，却一个事件都收不到"。
     */
    middleSignalPath = path.join(app.getPath('userData'), 'middle-click.signal');
    try {
      fs.writeFileSync(middleSignalPath, '');
    } catch {}
    middleSignalSize = 0;

    const encoded = Buffer.from(MIDDLE_CLICK_PS, 'utf16le').toString('base64');
    middleClickProc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        /* 不抓输出：stdout 丢掉，只靠信号文件通信 */
        stdio: 'ignore',
        env: { ...process.env, MR_MIDDLE_SIGNAL: middleSignalPath },
      }
    );
    middleClickProc.on('error', (e) => {
      console.warn('[桌面歌词] 中键监听启动失败：', (e && e.message) || e);
      middleClickProc = null;
    });
    middleClickProc.on('exit', () => {
      middleClickProc = null;
    });

    /*
     * 轮询信号文件的大小。
     * 只比大小、不读内容 —— 每按一次中键文件长 1 字节，
     * 大小变了就是"按了一次"，简单且不会漏（不需要解析内容）。
     */
    middleSignalTimer = setInterval(() => {
      if (!middleSignalPath) return;
      try {
        const size = fs.statSync(middleSignalPath).size;
        if (size > middleSignalSize) {
          const times = size - middleSignalSize;
          middleSignalSize = size;
          // 连按只算一次，避免手抖多切几次
          onGlobalMiddleClick(times);
        } else if (size < middleSignalSize) {
          middleSignalSize = size; // 文件被重建过
        }
      } catch {}
    }, 80);
    console.log('[桌面歌词] 中键监听已启动');
  } catch (e) {
    console.warn('[桌面歌词] 中键监听异常：', (e && e.message) || e);
    middleClickProc = null;
  }
}
function stopMiddleClickWatcher() {
  if (middleSignalTimer) {
    clearInterval(middleSignalTimer);
    middleSignalTimer = null;
  }
  if (middleClickProc) {
    try {
      middleClickProc.kill();
    } catch {}
    middleClickProc = null;
  }
}

function createLyricWindow() {
  if (lyricWindow && !lyricWindow.isDestroyed()) return lyricWindow;
  /*
   * 窗口铺满屏幕（不再是 900x190 的小条）。
   * 位置由"内容偏移"决定，所以窗口本身固定不动 —— 见文件开头那段说明。
   */
  const b = lyricFullBounds();

  lyricWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    /* 尺寸是固定的（不贴合文字），所以锁死 —— 可调整边框也是"能看到边框"的来源之一 */
    resizable: false,
movable: true,
    /*
     * ★ focusable: false —— 这一条是照着 Mineradio 抄的，而且是拖动卡顿的关键。
     *
     * 它会给窗口加上 WS_EX_NOACTIVATE（0x08000000）。
     * 对比过两个窗口的系统样式位：
     *   我的         exstyle=0x00280028  （没有 NOACTIVATE）
     *   Mineradio 的 exstyle=0x08280028  （有）
     * 带这个标志的窗口**永远不参与激活** —— 于是每次 SetWindowPos
     * 都跳过激活那一整套流程，移动明显更便宜。
     *
     * 桌面歌词是个浮在别人窗口上的字条，本来就不该抢焦点，
     * 所以这个设置本身也是对的，不只是为了性能。
     */
    focusable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    /* 不要 show:false + ready-to-show —— 那会在启动瞬间闪一下白底 */
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  lyricWindow.setAlwaysOnTop(true, 'screen-saver');
  lyricWindow.setVisibleOnAllWorkspaces(true);

  const url = isDev ? DEV_URL.replace(/index\.html.*$/, '') + 'lyric.html' : 'app://bundle/lyric.html';
  void lyricWindow.loadURL(url);

  lyricWindow.on('move', () => {
    // 窗口被外部挪过（系统、别的代码），本地缓存作废
    if (!lyricDragging) { lyricPosX = null; lyricPosY = null; }
    scheduleSaveLyricBounds();
    // 窗口一挪，热点的屏幕坐标就变了，立刻重算一次
    applyLyricMouseBehavior();
  });
  startLyricMousePoller();
  lyricWindow.on('closed', () => {
    lyricWindow = null;
    stopLyricMousePoller();
    lyricMouseIgnored = null;
  });
  // 页面加载完要把当前锁定状态告诉它，否则提示会显示成错的
  lyricWindow.webContents.on('did-finish-load', () => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return;
    lyricWindow.webContents.send('lyric:lock', lyricLocked);
    /*
     * ★ 偏移也要在这里补发一次。
     *
     * showLyricWindow 里发的那次很可能赶在页面注册监听之前 ——
     * 消息丢了，页面就停在 (0,0)，文字位置不对（用户看到的是"词在哪"）。
     */
    if (!lyricOffsetReady) {
      /*
       * 默认位置：水平居中、垂直偏下（屏幕高度的 27% 处，约在屏幕 77% 的高度）。
       *
       * ★ 偏移是**相对屏幕中心**的（0,0 = 正中央）——
       * 这是页面里 .positioner 的语义，不是窗口坐标。
       * 我第一版在这里填了窗口坐标 (404, 822)，语义不对，文字被推到屏幕外。
       */
      const full = lyricFullBounds();
      lyricOffsetX = 0;
      lyricOffsetY = Math.round(full.height * 0.27);
      lyricOffsetReady = true;
    }
    lyricWindow.webContents.send('lyric:offset', { x: lyricOffsetX, y: lyricOffsetY });
  });
  console.log('[桌面歌词] 窗口已创建');
  return lyricWindow;
}

function showLyricWindow(on) {
  if (on) {
    /*
     * 已经在显示就不重复创建（重复创建会多出一个窗口）。
     */
    if (lyricWindow && !lyricWindow.isDestroyed() && lyricWindow.isVisible()) return true;

    /*
     * 每次打开都从"未锁定"开始。
     * 锁定 = 整窗穿透 = 收不到任何鼠标事件，如果它被持久化，
     * 用户就会永久卡住。所以"关掉再打开"必须是一条能出去的通道。
     */
    lyricLocked = false;
    lyricHardLock = false;

    // 若还剩一个已销毁/隐藏的实例，先彻底清掉再建新的
    if (lyricWindow && !lyricWindow.isDestroyed()) {
      stopLyricMousePoller();
      stopMiddleClickWatcher();
      lyricWindow.destroy();
      lyricWindow = null;
    }

    createLyricWindow();
    if (!lyricWindow || lyricWindow.isDestroyed()) return !!on;

    if (!lyricOffsetReady) {
      /* 偏移是**相对屏幕中心**的（0,0 = 正中央），不是窗口坐标 */
      const full = lyricFullBounds();
      lyricOffsetX = 0;
      lyricOffsetY = Math.round(full.height * 0.27);
      lyricOffsetReady = true;
    }
    lyricWindow.webContents.send('lyric:offset', { x: lyricOffsetX, y: lyricOffsetY });
    lyricWindow.showInactive(); // 不抢焦点
    startLyricMousePoller();
    startMiddleClickWatcher();
    lyricMouseIgnored = null;
    applyLyricMouseBehavior();
  } else if (lyricWindow && !lyricWindow.isDestroyed()) {
    /*
     * ★ 关掉 = **销毁**，不是隐藏。
     *
     * hide() 之后再 showInactive()，窗口就再也收不到鼠标事件了
     *（日志里 pointerdown 恒为 0），而各项状态又都正常 —— 查不出原因。
     * 与其继续追那个内部机制，不如消掉这个转换：
     * 重建的窗口是一份全新状态，没有"上一次留下了什么"可言。
     */
    stopLyricMousePoller();
    stopMiddleClickWatcher();
    lyricWindow.destroy();
    lyricWindow = null;
    lyricMouseIgnored = null;
    lyricHotBounds = null;
  }
  return !!on;
}

/** 主界面推来的歌词/歌名 —— 原样转发给歌词窗口，主进程不解析 */
function pushLyric(payload) {
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  lyricWindow.webContents.send('lyric:update', payload || {});
}

function createWindow() {
  const savedState = loadWindowState();
  mainWindow = new BrowserWindow({
    // 没存过就用默认尺寸；存过就回到上次的位置和大小
    ...(savedState || { width: 1240, height: 800 }),
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#08090B',
    title: '音乐播放器',
    // 无边框 + 沉浸式：窗口装饰交给界面自己做（顶部的拖拽条与窗口按钮），
    // 这样粒子背景能一直铺到窗口边缘，没有系统标题栏割裂画面。
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /*
       * 关掉后台节流。
       *
       * 默认开启时，窗口一旦失去焦点或被别的窗口挡住，Chromium 就会把 rAF 和定时器
       * 降频 —— 粒子动画立刻变得一顿一顿的，切回来还要一会儿才恢复。
       * 音乐播放器本来就应该在后台稳定运行（而且还要出桌面歌词、托盘图标），
       * 所以这里明确关掉。
       *
       * 副作用要知情：关掉之后即使窗口在后台，GPU 也会继续满负荷画粒子。
       * 真要为省电考虑，应该在"窗口不可见时暂停渲染"上做（ParticleStage 里
       * 已经按 visibilitychange 暂停了），而不是靠这个粗粒度的节流。
       */
      backgroundThrottling: false,
    },
  });

  // 最大化状态要单独恢复（见 saveWindowState 里的说明）
  if (savedState && savedState.maximized) mainWindow.maximize();
  /*
   * 拖动和缩放分别监听：Windows 上拖窗口只触发 move、拉边框只触发 resize，
   * 两个都挂才能覆盖全。节流在 scheduleSaveWindowState 里做。
   */
  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('move', scheduleSaveWindowState);
  mainWindow.on('close', saveWindowState);

  mainWindow.once('ready-to-show', () => mainWindow.show());
  createTray();

  // 外链走系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // 走自定义协议，这样原生 ES 模块和 import map 才能正常加载
    void mainWindow.loadURL('app://bundle/index.html');
  }

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main] 页面加载失败 ${code} ${desc} ${url}`);
  });

  // 把渲染进程的 console 转发到主进程日志，否则界面里的报错无处可见
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['debug', 'info', 'warn', 'error'][level] || `l${level}`;
    console.log(`[渲染:${tag}] ${message}   (${String(sourceId).split('/').pop()}:${line})`);
  });

  // 页面 JS 抛未捕获异常时也记下来
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] 渲染进程退出:', JSON.stringify(details));
  });

  /*
   * 性能基准：设了 MP_BENCH=1 时，页面加载完成后自动跑一次逐层 A/B 测帧，
   * 结果打到日志。这样定位瓶颈不需要人工反复点界面、也不需要你重启着看图。
   */
  /*
   * 截图：设了 MP_SHOT=<目录> 时，页面加载后按几个不同配置各截一张图。
   *
   * 为什么要这个：像"泛光是不是变弱了""效果看起来拉了"这类问题，靠读数值和读代码
   * 都判断不了 —— 只能看图。有了它就能在改参数前后直接比对画面，而不是让你反复
   * 重启去看、再由你用嘴描述给我听。
   */
  /*
   * 封面检查：MP_COVERSHOT=<目录>
   * 播一首歌、切到正在播放页让封面聚拢成形，然后截一张图。
   * 专门用来检查"封面点阵好不好看"——它只在正在播放页才成形，
   * 首页截到的是散开状态，看不出问题。
   */
  if (process.env.MP_COVERSHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.setTitle('音乐播放器 —— ⚠ 自动测试中（封面检查）');
      /*
       * 横幅必须一起挂上。
       *
       * 之前这里只改了窗口标题、漏了页面横幅 —— 因为 MP_COVERSHOT 是
       * 后来才加的模式，我加它的时候没回头补横幅。
       * 结果封面检查全程页面顶部是空的，用户看不出我在操作，
       * 只看到"软件自己切到正在播放页、还播起了歌"。
       * 凡是会自己动界面的测试模式，都必须挂横幅。
       */
      const banner = (t) =>
        mainWindow.webContents
          .executeJavaScript(`window.__mpTestBanner && window.__mpTestBanner(${JSON.stringify(t)})`, true)
          .catch(() => {});
      banner('封面检查：准备起播');
      setTimeout(async () => {
        const dir = process.env.MP_COVERSHOT;
        const fs = require('node:fs');
        /*
         * 探测一开始就掐掉设置存盘。
         *
         * 惨痛教训：有一次探测跑完，用户存的粒子效果被改成了别的
         * （测试里切过一圈效果，最后那个被写了进去），用户看到的是
         * "我的设置自己变了"。所有自动探测都必须从第一秒起就不可能写盘，
         * 而不是指望每个探测函数自己记得关。
         */
        await mainWindow.webContents
          .executeJavaScript('window.__mpSuppressSave && window.__mpSuppressSave(true)', true)
          .catch(() => {});
        /*
         * 探测统一用默认效果（声纹星盘）拍，这样每次截图之间可比 ——
         * 之前有一次用户的存档被测试改成了别的效果，于是两张截图
         * 根本不是一个效果，我却拿去对比，白看半天。
         */
        await mainWindow.webContents
          .executeJavaScript('window.__mpSet && window.__mpSet({effect:"spectrum"})', true)
          .catch(() => {});
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {}
        try {
          const r = await mainWindow.webContents.executeJavaScript(
            'window.__mpShowCover && window.__mpShowCover()',
            true
          );
          console.log('[封面检查]', JSON.stringify(r));
        } catch (e) {
          console.error('[封面检查] 失败:', e && e.message);
        }

/* ------------------------------------------------------------------ */

        /*
         * 拍三张对照图：合成 / 只有背景粒子 / 只有封面。
         * 这样"那团东西是谁画的"就不用猜了 —— 直接看哪张里还有它。
         */
        const layer = async (js, label) => {
          banner(`封面检查：${label}`);
          try {
            await mainWindow.webContents.executeJavaScript(js, true);
          } catch (e) {
            console.error(`[封面检查] 切层失败 ${label}:`, e && e.message);
          }
          await new Promise((res) => setTimeout(res, 900));
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(path.join(dir, `${label}.png`), img.toPNG());
          console.log(`[封面检查] 已保存 ${label}.png`);
        };

        await layer('window.__mpLayers({particles:true, cover:true})', '1-合成');
        await layer('window.__mpLayers({particles:true, cover:false})', '2-只有背景粒子');
        await layer('window.__mpLayers({particles:false, cover:true})', '3-只有封面');
        /*
         * 空间感检查：把相机转到不同角度各拍一张。
         * "能绕着看"是这个视觉的关键，但只看一张正面图完全判断不出来 ——
         * 必须从侧面看才能确认它真的是一块立体的东西，而不是平贴图。
         */
        await layer('window.__mpOrbit(0, 0)', '5-正面');
        await layer('window.__mpOrbit(34, 14)', '6-右前侧');
        await layer('window.__mpOrbit(-46, -10)', '7-左后侧');
        await layer('window.__mpOrbit(0, 0)', '8-复位');
        await layer('window.__mpLayers({particles:true, cover:true})', '4-还原');

        /*
         * 自动回正检查：停手 3 秒后相机应该自己滑回正面。
         * 分两次读角度 —— 2 秒时还没到延时，应该原样停着；
         * 6 秒时早过了延时，应该已经归零。只看最终值分不清
         * "回正生效" 和 "根本没转过去"，所以必须取中间点。
         */
        const readOrbit = () =>
          mainWindow.webContents
            .executeJavaScript('window.__mpOrbit()', true)
            .catch((e) => ({ error: String(e) }));
        await mainWindow.webContents
          .executeJavaScript('window.__mpOrbit(34, 14)', true)
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 2000));
        console.log('[回正检查] 停手 2 秒：', JSON.stringify(await readOrbit()));
        await new Promise((r) => setTimeout(r, 4000));
        console.log('[回正检查] 停手 6 秒：', JSON.stringify(await readOrbit()));

        /* 切粒子效果也该把相机甩回正面 */
        await mainWindow.webContents
          .executeJavaScript('window.__mpOrbit(40, 18)', true)
          .catch(() => {});
        await mainWindow.webContents
          .executeJavaScript('window.__mpSet({effect:"coral"})', true)
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 700));
        console.log('[切效果回正检查] 切到光珊瑚后：', JSON.stringify(await readOrbit()));
        await mainWindow.webContents
          .executeJavaScript('window.__mpSet({effect:"spectrum"})', true)
          .catch(() => {});

        await mainWindow.webContents
          .executeJavaScript('window.__mpTestBannerOff && window.__mpTestBannerOff()', true)
          .catch(() => {});
        await mainWindow.webContents
          .executeJavaScript('window.__mpSuppressSave && window.__mpSuppressSave(false)', true)
          .catch(() => {});
        mainWindow.setTitle('音乐播放器');
        // 探测跑完就自己退出，不然窗口要一直挂到被超时杀掉
        app.quit();
      }, 3000);
    });
  }

  if (process.env.MP_REPL) {
    /*
     * ============ 常驻控制通道 ============
     *
     * 为什么要有这个东西：
     * 这台机器的沙箱禁止命名管道，而 Electron 的 Chromium 进程间通信**必须**用
     * 命名管道（platform_channel.cc 会直接 FATAL）。所以每启动一次 Electron
     * 都要单独授权一次。一轮视觉/性能验证要启动七八次，就是七八次弹窗 ——
     * 用户明确说了不想按。
     *
     * 办法：**只启动一次，然后不要再启动**。
     * 主进程每 300ms 读一次工作区里的 cmd.json（主进程有完整文件权限，
     * 写工作区文件不受沙箱限制），把里面的 js 丢给渲染进程执行，
     * 结果追加到 out.jsonl。于是之后所有调试都只是"改一个文件、读一个文件"，
     * 全程不再有新的进程，也就不再需要任何授权。
     *
     * cmd.json 形如：
     *   { "seq": 7, "js": "window.__mpInfo()", "shot": "D:\\...\\a.png" }
     * seq 变了才执行（用它做"这是新命令"的判据，避免重复执行同一条）。
     */
    const dir = process.env.MP_REPL;
    const fsRepl = require('node:fs');
    const pathRepl = require('node:path');
    try {
      fsRepl.mkdirSync(dir, { recursive: true });
    } catch {}
    const cmdFile = pathRepl.join(dir, 'cmd.json');
    const outFile = pathRepl.join(dir, 'out.jsonl');
    let lastSeq = -1;
    const write = (obj) => {
      try {
        fsRepl.appendFileSync(outFile, JSON.stringify(obj) + '\n');
      } catch {}
    };

    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.setTitle('音乐播放器 —— ⚠ REPL 调试中（请勿手动操作此窗口）');
      // 等首页数据、粒子舞台、封面都就绪
      setTimeout(() => {
        console.log(`[REPL] 已就绪，等待 ${cmdFile}`);
        write({ ready: true, t: Date.now() });
        setInterval(async () => {
          let cmd = null;
          try {
            cmd = JSON.parse(fsRepl.readFileSync(cmdFile, 'utf8'));
          } catch {
            return; // 文件不存在或写了一半，下一轮再说
          }
          if (!cmd || typeof cmd.seq !== 'number' || cmd.seq === lastSeq) return;
          lastSeq = cmd.seq;
          let result = null;
          let error = null;
          try {
            const r = await mainWindow.webContents.executeJavaScript(
              String(cmd.js == null ? 'null' : cmd.js),
              true
            );
            result = r === undefined ? null : r;
          } catch (e) {
            error = String((e && e.message) || e);
          }
          write({ seq: cmd.seq, t: Date.now(), error, result });
          if (cmd.shot) {
            try {
              const img = await mainWindow.webContents.capturePage();
              fsRepl.writeFileSync(cmd.shot, img.toPNG());
              write({ seq: cmd.seq, shot: cmd.shot, bytes: img.toPNG().length });
            } catch (e) {
              write({ seq: cmd.seq, shotError: String((e && e.message) || e) });
            }
          }
          if (cmd.quit) app.quit();
        }, 300);
      }, 5000);
    });
  }

  if (process.env.MP_JANK) {
    /*
     * 流畅度剖析。
     *
     * 专门为"到底卡在哪"造的场景：**不截图**（截图本身会制造大量卡顿，
     * 把真实问题淹掉），只做用户日常会做的动作 —— 起播、静置、切歌、换效果，
     * 每个动作之间留足静置时间，让日志里的卡顿能明确对上事件标记。
     */
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.setTitle('音乐播放器 —— ⚠ 自动测试中（流畅度剖析）');
      void mainWindow.webContents
        .executeJavaScript("window.__mpTestBanner && window.__mpTestBanner('流畅度剖析中')", true)
        .catch(() => {});
      setTimeout(async () => {
        const js = (code) =>
          mainWindow.webContents.executeJavaScript(code, true).catch((e) => String(e && e.message));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await js('window.__mpSuppressSave && window.__mpSuppressSave(true)');
        await js('window.__mpShowCover && window.__mpShowCover()');
        console.log('[剖析] 起播完成，静置 9 秒看稳态');
        await wait(9000);

        console.log('[剖析] === 连续切歌 4 次 ===');
        for (let i = 0; i < 4; i++) {
          await js("document.querySelector('#pb-next').click()");
          await wait(3200);
        }

        console.log('[剖析] === 连续换效果 ===');
        for (const k of ['coral', 'tunnel', 'vinyl', 'spectrum']) {
          await js(`window.__mpSet && window.__mpSet({effect:"${k}"})`);
          await wait(3200);
        }

        console.log('[剖析] === 收尾静置 ===');
        await wait(6000);
        await js('window.__mpTestBannerOff && window.__mpTestBannerOff()');
        mainWindow.setTitle('音乐播放器');
        app.quit();
      }, 3500);
    });
  }

  if (process.env.MP_SHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.setTitle('音乐播放器 —— ⚠ 自动测试中（截图，请勿使用此窗口）');
      void mainWindow.webContents
        .executeJavaScript("window.__mpTestBanner && window.__mpTestBanner('截图对比中')", true)
        .catch(() => {});
      setTimeout(async () => {
        const dir = process.env.MP_SHOT;
        const fs = require('node:fs');
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {}

        const shoot = async (name) => {
          const img = await mainWindow.webContents.capturePage();
          const file = path.join(dir, `${name}.png`);
          fs.writeFileSync(file, img.toPNG());
          const size = img.getSize();

          /*
           * 顺便算一下这张图的亮度统计。
           *
           * 起因：这轮开发里没法用眼睛看画面（模型不支持读图），
           * 而"泛光够不够""画面是不是发灰"这类判断又只能看图。于是改成量化的：
           * 泛光变强会把整体亮度抬高、把亮斑铺开，所以平均值、亮部占比、
           * 以及"高亮像素的百分比"能客观反映光晕的多少，用来横向比对几个档位。
           */
          let stats = '';
          try {
            const bmp = img.getBitmap(); // BGRA
            const n = size.width * size.height;
            let sum = 0;
            let hi = 0; // 亮度 > 96 的像素（光晕/亮核）
            let mid = 0; // 亮度 > 32（可见的粒子光）
            let veryHi = 0; // 亮度 > 176（过曝区）
            const hist = new Uint32Array(256);
            // 隔行隔列采样，几百毫秒的活降到几毫秒
            for (let y = 0; y < size.height; y += 2) {
              for (let x = 0; x < size.width; x += 2) {
                const i = (y * size.width + x) * 4;
                const b = bmp[i];
                const g = bmp[i + 1];
                const r = bmp[i + 2];
                const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
                sum += lum;
                hist[lum]++;
                if (lum > 32) mid++;
                if (lum > 96) hi++;
                if (lum > 176) veryHi++;
              }
            }
            const sampled = hist.reduce((a, b) => a + b, 0);
            const mean = sum / sampled;
            // 中位数
            let acc = 0;
            let p50 = 0;
            for (let v = 0; v < 256; v++) {
              acc += hist[v];
              if (acc >= sampled / 2) {
                p50 = v;
                break;
              }
            }
            stats =
              `  平均亮度=${mean.toFixed(1)} 中位=${p50}` +
              `  亮部(>96)=${((hi / sampled) * 100).toFixed(2)}%` +
              `  过曝(>176)=${((veryHi / sampled) * 100).toFixed(2)}%` +
              `  可见光(>32)=${((mid / sampled) * 100).toFixed(1)}%`;
          } catch (e) {
            stats = `  (统计失败: ${e.message})`;
          }

          console.log(`[截图] ${file}  (${size.width}x${size.height})`);
          console.log(`[截图]${stats}`);
        };

        // 让第一首播起来，这样才有封面氛围背景、节拍也在跑
        try {
          await mainWindow.webContents.executeJavaScript(
            "document.querySelector('.row') && document.querySelector('.row').click(); true",
            true
          );
        } catch {}
        await new Promise((r) => setTimeout(r, 9000));

        // 冻结粒子动画：这样所有截图的粒子位置完全一致，
        // 画面差异只可能来自被改的那一项（泛光），统计才有可比性
        try {
          await mainWindow.webContents.executeJavaScript('window.__mpFreeze && window.__mpFreeze(true)', true);
        } catch {}

        /*
         * 关掉专辑氛围背景。
         *
         * 起因：上一轮截图里亮度出现双峰（7.5 / 23.3 / 7.4），过曝像素差 10 倍，
         * 完全盖住了泛光本身的差异。专辑封面是一大片会淡入淡出的彩色区域，
         * 它一亮就把整幅图的统计抬起来 —— 必须先把这个变量拿掉，
         * 剩下的差异才只可能来自泛光。
         */
        try {
          await mainWindow.webContents.executeJavaScript(
            'window.__mpBgOff && window.__mpBgOff()',
            true
          );
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));

        // 先把色彩管线配置打出来 —— 它决定了整个后处理链的亮度
        try {
          const info = await mainWindow.webContents.executeJavaScript('window.__mpInfo && window.__mpInfo()', true);
          console.log('[管线] ===== 渲染色彩管线 =====');
          for (const [k, v] of Object.entries(info)) {
            if (k === 'passes') {
              console.log('[管线] passes:');
              for (const p of v) console.log(`[管线]     ${JSON.stringify(p)}`);
            } else {
              console.log(`[管线] ${k.padEnd(48)} = ${v}`);
            }
          }
          console.log('[管线] ========================');
        } catch (e) {
          console.error('[管线] 查询失败:', e && e.message);
        }

        // 几个关键配置各截一张，方便横向对比
        const variants = [
          ['A-泛光关', 'window.__mpSet({bloom:false})'],
          ['B-泛光0.5', 'window.__mpSet({bloom:true,bloomStrength:0.5})'],
          ['C-泛光0.9默认', 'window.__mpSet({bloom:true,bloomStrength:0.9})'],
          ['D-泛光1.3', 'window.__mpSet({bloom:true,bloomStrength:1.3})'],
          ['E-泛光1.8', 'window.__mpSet({bloom:true,bloomStrength:1.8})'],
          ['F-泛光2.6', 'window.__mpSet({bloom:true,bloomStrength:2.6})'],
        ];
        for (const [name, js] of variants) {
          try {
            await mainWindow.webContents.executeJavaScript(js, true);
          } catch (e) {
            console.error(`[截图] 应用 ${name} 失败:`, e && e.message);
          }
          await new Promise((r) => setTimeout(r, 1800));
          await shoot(name);
        }
        console.log('[截图] 完成');
        // 同样要收尾：撤横幅、恢复标题
        await mainWindow.webContents
          .executeJavaScript('window.__mpTestBannerOff && window.__mpTestBannerOff()', true)
          .catch(() => {});
        mainWindow.setTitle('音乐播放器');
        console.log('[截图] 测试结束，横幅已撤掉，窗口已恢复为正常状态');
      }, 4000);
    });
  }

  if (process.env.MP_BENCH) {
    mainWindow.webContents.once('did-finish-load', () => {
      /*
       * 测试模式必须**一眼可见**。
       *
       * 自动化测试跑在同一个窗口里，它会自己点歌、暂停、切画质档位 ——
       * 从外面完全看不出来，于是测试中的异常表现被当成产品 bug 报回来，
       * 来回浪费了好几轮。所以这里做三件事：
       *   1. 改窗口标题（任务栏也能看到）
       *   2. 页面顶部挂一条闪烁横幅，并随测试阶段更新文字
       *   3. 测试结束（无论成功失败）自动撤掉
       */
      const TEST_TITLE = '音乐播放器 —— ⚠ 自动测试中（请勿使用此窗口）';
      mainWindow.setTitle(TEST_TITLE);
      const banner = (t) =>
        mainWindow.webContents
          .executeJavaScript(`window.__mpTestBanner && window.__mpTestBanner(${JSON.stringify(t)})`, true)
          .catch(() => {});
      const bannerOff = () =>
        mainWindow.webContents
          .executeJavaScript('window.__mpTestBannerOff && window.__mpTestBannerOff()', true)
          .catch(() => {});

      banner('启动中');
      // 等首页数据、粒子舞台都就绪
      setTimeout(() => {
        const script = process.env.MP_CYCLE
          ? 'window.__mpCycleEffects && window.__mpCycleEffects()'
          : process.env.MP_PULSE
            ? 'window.__mpPulseProbe && window.__mpPulseProbe()'
            : 'window.__mpBench && window.__mpBench()';
        if (process.env.MP_CYCLE) banner('逐个检查粒子效果');
        else if (process.env.MP_PULSE) banner('节奏探测中');
        else banner('性能基准中');
        mainWindow.webContents
          .executeJavaScript(script, true)
          .then((r) => {
            // 效果轮检模式：报出每个效果有没有真的切过去（着色器语法错会导致切不过去）
            if (process.env.MP_CYCLE) {
              console.log('[效果检查] ===== 逐个效果检查 =====');
              for (const it of r || []) {
                console.log(`[效果检查] ${it.生效 ? '✓' : '✗'}  ${it.effect}`);
              }
              console.log('[效果检查] ========================');
              return;
            }
            if (process.env.MP_PULSE) {
              if (r && r.error) {
                console.error('[律动] 出错:', r.error);
                return;
              }
              console.log('[律动] ===== 切换档位时的律动数值 =====');
              for (const s of r) {
                console.log(`[律动] ${s.tag}`);
                for (const [k, v] of Object.entries(s)) {
                  if (k !== 'tag') console.log(`[律动]     ${k.padEnd(24)} = ${v}`);
                }
              }
              console.log('[律动] ================================');
              return;
            }
            if (r && r.error) {
              console.error('[基准] 出错:', r.error);
              return;
            }
            console.log('[基准] ===== 逐层帧率基准 =====');
            console.log(`[基准] CSS=${r.sizing.css}  dpr=${r.sizing.dpr}  scale=${r.sizing.scale}`);
            console.log(`[基准] 画布像素=${r.sizing.drawingBuffer}  composer=${r.sizing.composer}  磨砂生效=${r.sizing.blurOn}`);
            const g = r.sizing.gl || {};
            console.log(`[基准] WebGL 版本 = ${g.version}`);
            console.log(`[基准] WebGL 厂商 = ${g.vendor}`);
            console.log(`[基准] WebGL 渲染器 = ${g.renderer}`);
            console.log(`[基准] 是否软件渲染 = ${g.isSoftware ? '是（SwiftShader 之类，GPU 优化全部无效）' : '否'}`);
            let prev = null;
            for (const it of r.results) {
              const d = prev === null ? '' : `   (${it.fps - prev >= 0 ? '+' : ''}${it.fps - prev})`;
              console.log(`[基准] ${String(it.fps).padStart(4)} FPS   ${it.label}${d}`);
              prev = it.fps;
            }
            console.log('[基准] =========================');
          })
          .catch((e) => console.error('[基准] 失败:', e && e.message))
          /*
           * 无论成功失败，都撤掉横幅、恢复标题。
           *
           * 这一步不能省：早期测试脚本出错时收尾没执行，横幅（或者更早版本的
           * 存盘抑制）就留在那儿了。测试必须保证"怎么结束的都收得干净"。
           */
          .finally(() => {
            bannerOff();
            mainWindow.setTitle('音乐播放器');
            console.log('[基准] 测试结束，横幅已撤掉，窗口已恢复为正常状态');
          });
      }, 5000);
    });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * 记录 GPU 信息
 *
 * 重点确认两件事：
 *   1. 用的是独显/核显，还是 Chromium 退回了 SwiftShader 软件渲染
 *      —— 软件渲染的话，任何粒子优化都是白费力气
 *   2. 有没有因为 GPU 进程崩溃而禁用硬件加速（gpu_compositing 状态）
 */
function logGpuInfo() {
  try {
    app.getGPUInfo('basic').then(
      (info) => {
        const g = (info && info.gpuDevice) || [];
        /*
         * 把**所有**显卡都列出来。
         *
         * 原来只打 g[0]，在双显卡笔记本上会让人以为"这台机器只有核显"，从而
         * 完全走错优化方向（实测踩过：一直以为是核显不行，实际独显全程闲着）。
         * 到底哪块在干活，要看渲染进程报的 UNMASKED_RENDERER_WEBGL。
         */
        console.log(`[GPU] 系统共检测到 ${g.length} 块显卡：`);
        g.forEach((d, i) => {
          console.log(
            `[GPU]   [${i}] 设备="${d.deviceString || d.deviceId || '未知'}"  ` +
              `厂商="${d.vendorId || '?'}"  驱动="${d.driverVersion || '?'}"`
          );
        });
        if (info && info.auxAttributes) {
          const a = info.auxAttributes;
          console.log(
            `[GPU] 硬件加速=${a.glRenderer ? '开' : '未知'}  ` +
              `gpu_compositing=${a.gpuCompositing || '?'}  ` +
              `software_rendering=${a.softwareRendering ? '是（严重问题）' : '否'}`
          );
        }
      },
      (e) => console.log('[GPU] 取信息失败:', e && e.message)
    );
  } catch (e) {
    console.log('[GPU] 异常:', e && e.message);
  }
}

app.whenReady().then(() => {
  logGpuInfo();
  if (!isDev) protocol.handle('app', serveUiAsset);

  getClient(); // 提前初始化，让设备身份在启动时就落盘
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  /*
   * 有托盘之后**不能在这里退出** —— 窗口被收进托盘时就走到这里了。
   * 真正的退出只有两条路：托盘菜单的「退出」，以及快捷键里的退出
   * （它们都会先立 app.isQuitting）。
   */
  if (process.platform !== 'darwin' && (app.isQuitting || !tray)) app.quit();
});

/* 未捕获异常写日志，避免静默退出（Electron 主进程里 console 可能没有输出端） */
process.on('uncaughtException', (err) => {
  console.error('[main] 未捕获异常:', err);
});

/* 系统托盘                                                            */
/* ------------------------------------------------------------------ */

/**
 * 手写一个 32x32 的 PNG 当托盘图标。
 *
 * 为什么要自己编码：Tray 需要一个图标文件，而这个项目里没有任何
 * .ico / .png 资源。为了一张图标往仓库塞二进制不值当 ——
 * 这里用 zlib 现场压一个出来，改图标只要改下面那几行像素逻辑。
 */
function pngFromRGBA(rgba, w, h) {
  const zlib = require('node:zlib');
  // CRC32（PNG 每个块都要）
  const table = (() => {
    const tb = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tb[n] = c;
    }
    return tb;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 每行前面要加一个 filter 字节（0 = None）
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 画一张"黑胶唱片"样子的图标：深色圆盘 + 亮环 + 中心点 */
function makeTrayIcon() {
  const S = 32;
  const px = Buffer.alloc(S * S * 4, 0);
  const c = (S - 1) / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * S + x) * 4;
      if (d > 15) continue; // 圆外透明
      if (Math.abs(d - 11) < 2.6 || d < 3.0) {
        px[i] = 236; px[i + 1] = 244; px[i + 2] = 255; px[i + 3] = 255; // 亮环 + 中心
      } else if (Math.abs(d - 7.2) < 1.6) {
        px[i] = 120; px[i + 1] = 170; px[i + 2] = 230; px[i + 3] = 255; // 细沟槽
      } else {
        px[i] = 14; px[i + 1] = 17; px[i + 2] = 24; px[i + 3] = 235; // 盘面
      }
    }
  }
  return pngFromRGBA(px, S, S);
}

let tray = null;
let closeHintShown = false;

/** 托盘菜单里的一条：把动作发回渲染进程执行（状态都在那边） */
function trayAction(action) {
  /*
   * 这里**不能**调 sendGlobalHotkeyAction：那个函数定义在 registerIpc() 内部，
   * 而托盘模块在文件最末尾、属于模块级作用域 —— 看不见它。
   * （这就是之前 "createTray is not defined" 那个坑的另一面：
   *   同一段代码在两个不同作用域里，谁看得见谁是问号。）
   * 直接发同一条 IPC，效果完全一样。
   */
  if (!mainWindow || mainWindow.isDestroyed() || !action) return;
  mainWindow.webContents.send('hotkeys:action', { action });
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

function createTray() {
  if (tray) return tray;
  try {
    const img = nativeImage.createFromBuffer(makeTrayIcon());
    tray = new Tray(img);
  } catch (e) {
    console.error('[托盘] 创建失败:', (e && e.message) || e);
    return null;
  }
  tray.setToolTip('音乐播放器');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏窗口', click: toggleWindow },
      { type: 'separator' },
      { label: '播放 / 暂停', click: () => trayAction('playpause') },
      { label: '上一首', click: () => trayAction('prev') },
      { label: '下一首', click: () => trayAction('next') },
      { type: 'separator' },
      { label: '静音开关', click: () => trayAction('mute') },
      {
        label: '退出',
        click: () => {
          /*
           * 必须先立这个标记再 quit。
           * 否则窗口的 close 会被"最小化到托盘"拦下来，点了退出却只是藏起来 ——
           * 这类 bug 在托盘应用里非常常见，用户会以为程序退不掉。
           */
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  // 单击托盘图标切换显示（Windows 上 click 就够）
  tray.on('click', toggleWindow);
  console.log('[托盘] 已创建');
  return tray;
}

  /*
   * 诊断：直接问歌词页"文字现在在哪"。
   *
   * 抓图对全屏透明窗口不可靠（抓出来是全白），所以改成从主进程
   * executeJavaScript 去查实际布局 —— 这是能拿到真相的办法。
   */
ipcMain.handle('lyric:where', async () => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return { error: 'NO_WINDOW' };
    /*
     * 把穿透判定的内部状态一并报出来。
     * "拖不动"最常见的原因就是窗口处于穿透状态（鼠标根本进不来），
     * 而这件事从外面完全看不出来 —— 必须把状态摊开。
     */
    const wb = lyricWindow.getBounds();
    const hot = lyricHotBoundsOnScreen();
    const cur = screen.getCursorScreenPoint();
    const state = {
      忽略鼠标: lyricMouseIgnored,
      锁定: lyricHardLock,
      正在拖动: lyricDragging,
      光标: cur.x + ',' + cur.y,
      窗口: wb.x + ',' + wb.y + ' ' + wb.width + 'x' + wb.height,
      热点: hot ? Math.round(hot.x) + ',' + Math.round(hot.y) + ' ' + Math.round(hot.width) + 'x' + Math.round(hot.height) : null,
      页面报的原始热点: lyricHotBounds,
      光标在热点内: hot ? (cur.x >= hot.x && cur.x <= hot.x + hot.width && cur.y >= hot.y && cur.y <= hot.y + hot.height) : 'no-hot',
    };
    try {
      const dom = await lyricWindow.webContents.executeJavaScript(`(() => {
        const m = document.getElementById('main');
        const p = document.querySelector('.positioner');
        const r = m ? m.getBoundingClientRect() : null;
        const cs = getComputedStyle(document.documentElement);
        return {
          text: m ? (m.textContent || '').slice(0, 30) : null,
          rect: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
          lx: cs.getPropertyValue('--lx').trim(),
          ly: cs.getPropertyValue('--ly').trim(),
          posTransform: p ? getComputedStyle(p).transform : null,
          innerW: window.innerWidth,
          innerH: window.innerHeight,
          bodyClass: document.body.className,
        };
      })()`);
      return { ...state, ...dom };
    } catch (e) {
      return { ...state, error: (e && e.message) || String(e) };
    }
  });

  /*
   * 自测：往歌词窗口注入一串合成指针事件，看偏移会不会变。
   *
   * 这样"拖动能不能用"我自己就能测 —— 不用等人按鼠标。
   * 合成事件走的是和真实指针一样的监听路径（pointerdown/move/up），
   * 所以能验证整条链：页面捕获 → moveBy → 主进程转发 → transform 变化。
   */
  ipcMain.handle('lyric:testDrag', async () => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return { error: 'NO_WINDOW' };
    try {
      return await lyricWindow.webContents.executeJavaScript(`(async () => {
        const root = document.documentElement;
        const before = { lx: root.style.getPropertyValue('--lx'), ly: root.style.getPropertyValue('--ly') };
        const stage = document.querySelector('.stage');
        const r = stage.getBoundingClientRect();
        const cx = Math.round(r.width / 2), cy = Math.round(r.height / 2);
        const mk = (type, x, y, buttons) => new PointerEvent(type, {
          pointerId: 1, pointerType: 'mouse', button: 0, buttons,
          clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true, cancelable: true,
        });
        document.body.dispatchEvent(mk('pointerdown', cx, cy, 1));
        for (let i = 1; i <= 5; i++) {
          window.dispatchEvent(mk('pointermove', cx + i * 10, cy + i * 5, 1));
          await new Promise((res) => setTimeout(res, 30));
        }
        window.dispatchEvent(mk('pointerup', cx + 50, cy + 25, 0));
        await new Promise((res) => setTimeout(res, 120));
        const after = { lx: root.style.getPropertyValue('--lx'), ly: root.style.getPropertyValue('--ly') };
        return { before, after, 有变化: before.lx !== after.lx || before.ly !== after.ly };
      })()`);
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  });

  /*
   * 探针：给定一个屏幕坐标，算出"穿透判定"会得出什么。
   *
   * 为什么需要它：判定逻辑依赖**真实光标位置**，而我没法用程序移动光标
   * （SetCursorPos 会被物理鼠标立刻覆盖）。加了这个之后，
   * "把光标放在文字上时判定应该是什么"就可以脱离鼠标单独验证。
   */
  ipcMain.handle('lyric:probe', (_e, pt) => {
    const hot = lyricHotBoundsOnScreen();
    const x = Number(pt && pt.x);
    const y = Number(pt && pt.y);
    const inside = hot ? x >= hot.x && x <= hot.x + hot.width && y >= hot.y && y <= hot.y + hot.height : null;
    return {
      窗口: lyricWindow && !lyricWindow.isDestroyed() ? JSON.stringify(lyricWindow.getBounds()) : null,
      窗口可见: !!(lyricWindow && !lyricWindow.isDestroyed() && lyricWindow.isVisible()),
      页面热点原始: lyricHotBounds,
      屏幕热点: hot ? Math.round(hot.x) + ',' + Math.round(hot.y) + ' ' + Math.round(hot.width) + 'x' + Math.round(hot.height) : null,
      探测点: x + ',' + y,
      在热点内: inside,
      当前忽略鼠标: lyricMouseIgnored,
      硬锁: lyricHardLock,
      轮询存活: !!lyricMousePoller,
      中键监听存活: !!middleClickProc,
      判定调用次数: probeCalls.applyBehavior,
    };
  });