'use strict';

/**
 * 预加载脚本
 *
 * 在开启 contextIsolation 的前提下，只把必要的接口暴露给渲染进程。
 * 渲染进程拿不到 Node 能力，也拿不到 ipcRenderer 本体，
 * 只能调用这里白名单列出的方法。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** 账号状态 */
  account: () => ipcRenderer.invoke('account'),
  /** 歌手详情 / 歌手歌曲 */
  artistDetail: (id) => ipcRenderer.invoke('artist:detail', id),
  artistSongs: (id, page, pagesize) => ipcRenderer.invoke('artist:songs', id, page, pagesize),
  /** 专辑详情 / 专辑歌曲 */
  albumDetail: (id) => ipcRenderer.invoke('album:detail', id),
  albumSongs: (id, page, pagesize) => ipcRenderer.invoke('album:songs', id, page, pagesize),
  /** 退出登录（清本地会话） */
  logout: () => ipcRenderer.invoke('account:logout'),
  /** 我的歌单列表 */
  playlists: () => ipcRenderer.invoke('playlists'),
  /** 某个歌单的全部歌曲 */
  playlistTracks: (id) => ipcRenderer.invoke('playlistTracks', id),
  /** 新建歌单（isPrivate: 0 公开 / 1 私密） */
  playlistCreate: (name, isPrivate) => ipcRenderer.invoke('playlistCreate', name, isPrivate),
  /** 删除歌单 */
  playlistDelete: (listid) => ipcRenderer.invoke('playlistDelete', listid),
  /** 往歌单加歌（songs 直接用搜索结果/mapSong 的产物） */
  playlistAddTracks: (listid, songs) => ipcRenderer.invoke('playlistAddTracks', listid, songs),
  /** 从歌单删歌（要 fileId，不是 hash） */
  playlistRemoveTracks: (listid, fileIds) => ipcRenderer.invoke('playlistRemoveTracks', listid, fileIds),
  /** 最近播放 */
  history: (page) => ipcRenderer.invoke('history', page),
  /** 上报一次播放事件（酷狗只记"听了这首歌"，不记进度） */
  historyUpload: (mxid) => ipcRenderer.invoke('historyUpload', mxid),

  /** 私人 FM（返回一批歌，前端排进队列一首首放） */
  personalFm: () => ipcRenderer.invoke('personalFm'),

  /** 搜索歌曲 */
  search: (kw, page, pagesize) => ipcRenderer.invoke('search', kw, page, pagesize),
  /** 取播放地址（内部已做移动端优先 + 网关降级），可指定音质 128 / 320 / flac */
  stream: (song, quality) => ipcRenderer.invoke('stream', song, quality),
  /** 取歌词（逐字歌词会自动解码） */
  lyric: (song) => ipcRenderer.invoke('lyric', song),

  /** 首页：每日推荐 */
  recommend: () => ipcRenderer.invoke('recommend'),
  /** 首页：排行榜列表 */
  ranks: () => ipcRenderer.invoke('ranks'),
  /** 首页：某个榜单的歌曲 */
  rankTracks: (rankId) => ipcRenderer.invoke('rankTracks', rankId),

  /** 已喜欢的全部歌曲 hash（用于判断当前歌是否已收藏） */
  favoriteHashes: () => ipcRenderer.invoke('favoriteHashes'),
  /** 加入「我喜欢」 */
  like: (song) => ipcRenderer.invoke('like', song),
  /** 从「我喜欢」移除 */
  unlike: (song) => ipcRenderer.invoke('unlike', song),
  /** 生成登录二维码 */
  loginQrCreate: () => ipcRenderer.invoke('loginQrCreate'),
  /** 轮询扫码状态 */
  loginQrCheck: (key) => ipcRenderer.invoke('loginQrCheck', key),

  /** 全局热键 */
  hotkeys: {
    /**
     * 用整张绑定表重新配置全局热键。
     * 返回逐条结果（ok / 冲突），界面上的"可用 / 被占用"就是它。
     */
    configure: (bindings) => ipcRenderer.invoke('hotkeys:configure', bindings),
    /**
     * 订阅热键动作。热键在主进程触发，但播放器状态在渲染进程，
     * 所以动作要发回来执行。
     * 返回取消订阅函数 —— 页面重建时不取消会叠加监听。
     */
    onAction: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('hotkeys:action', listener);
      return () => ipcRenderer.removeListener('hotkeys:action', listener);
    },
  },

  /** 桌面歌词 */
  desktopLyric: {
    toggle: (on) => ipcRenderer.invoke('lyric:toggle', on),
    visible: () => ipcRenderer.invoke('lyric:visible'),
    /** 当前是否处于"硬锁"（整窗穿透）状态 */
    locked: () => ipcRenderer.invoke('lyric:locked'),
/** 页面把当前内容偏移报回主进程（用于落盘） */
    setOffset: (off) => ipcRenderer.invoke('lyric:offset', off),
    /** 诊断：问歌词页文字在哪 */
    where: () => ipcRenderer.invoke('lyric:where'),
    testDrag: () => ipcRenderer.invoke('lyric:testDrag'),
    /** 诊断：给定屏幕坐标算出穿透判定结果 */
    probe: (pt) => ipcRenderer.invoke('lyric:probe', pt),
    /** 主进程推来的拖动位移 —— 页面拿它改 transform，**不移动窗口** */
    onMove: (cb) => {
      const fn = (_e, d) => cb(d);
      ipcRenderer.on('lyric:move', fn);
      return () => ipcRenderer.removeListener('lyric:move', fn);
    },
    /** 主进程推来的内容偏移（显示时、拖动开始时同步一次） */
    onOffset: (cb) => {
      const fn = (_e, o) => cb(o);
      ipcRenderer.on('lyric:offset', fn);
      return () => ipcRenderer.removeListener('lyric:offset', fn);
    },
    /** 拖动：页面算好差值，主进程挪窗口（不用系统拖拽，见 main.js 的说明） */
    moveBy: (dx, dy) => ipcRenderer.invoke('lyric:moveBy', dx, dy),
    /** 拖动开始/结束。开始时要冻结穿透判定，结束时要校准并落盘 */
    /** 基准：连续移动窗口 N 次并报告耗时（诊断用） */
    bench: (n) => ipcRenderer.invoke('lyric:bench', n),
    dragStart: () => ipcRenderer.invoke('lyric:dragStart'),
    dragEnd: () => ipcRenderer.invoke('lyric:dragEnd'),
    /** 歌词窗口量完"文字实际范围"后报给主进程，用来决定要不要穿透 */
    hotBounds: (rect) => ipcRenderer.invoke('lyric:hotBounds', rect),
    /** 诊断用：把歌词窗口看到的视口尺寸带出来 */
    diag: (d) => ipcRenderer.invoke('lyric:diag', d),
    /** 主界面把算好的歌词行推过去 */
    push: (payload) => ipcRenderer.invoke('lyric:push', payload),
    toggleLock: () => ipcRenderer.invoke('lyric:toggleLock'),
    setLock: (on) => ipcRenderer.invoke('lyric:setLock', on),
    /** 歌词窗口自己订阅（只有 lyric.html 用） */
    onUpdate: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('lyric:update', fn);
      return () => ipcRenderer.removeListener('lyric:update', fn);
    },
    onLock: (cb) => {
      const fn = (_e, v) => cb(v);
      ipcRenderer.on('lyric:lock', fn);
      return () => ipcRenderer.removeListener('lyric:lock', fn);
    },
  },

  /** 无边框窗口控制 */
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
  },
});
