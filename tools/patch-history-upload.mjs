/*
 * 播放历史上报。
 *
 * 为什么必须做：不做的话「最近播放」永远是你在酷狗官方客户端听过的那些，
 * 在这里听多少都不会变 —— 用户反馈"最近播放也不会刷新"，根子就在这。
 *
 * 而且 core 里那个包装函数**参数是错的**：vendor 模块要的是 mxid，
 * 它传的是 hash / album_id / album_audio_id / seconds / total，
 * 模块一个都不用 → mxid 变成 Number(undefined) = NaN。
 * 也就是说：这个函数就算被调用也是坏的，只是从来没人调用过，所以没暴露。
 *
 * 上报接口只要 { mxid, op, ot, pc } —— 一次播放事件，**不带进度**，
 * 所以每首歌上报一次就够，不需要定时轮询。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const log = (m) => console.log(m);

// ---------- ① core：把参数改成模块真正要的 ----------
{
  const f = path.join(root, 'packages', 'core', 'src', 'index.js');
  let t = fs.readFileSync(f, 'utf8');
  const from = `  async uploadPlayHistory({ hash, albumId = 0, albumAudioId = 0, seconds = 0, total = 0 }) {
    return this.call('playhistory_upload', {
      hash,
      album_id: albumId,
      album_audio_id: albumAudioId,
      seconds,
      total,
    });
  }`;
  const to = `  async uploadPlayHistory({ mxid = 0, mixSongId = 0, albumAudioId = 0, pc = 1, time = 0 } = {}) {
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
  }`;
  if (t.includes(from)) {
    t = t.replace(from, to);
    fs.writeFileSync(f, t);
    log('ok: core 上报参数');
  } else {
    log('!! core: 未匹配');
  }
}

// ---------- ② desktop IPC ----------
{
  const f = path.join(root, 'apps', 'desktop', 'main.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes("'historyUpload',")) {
    log('desktop: 已存在');
  } else {
    const anchor = `  /* ---- 私人 FM ---- */`;
    if (!t.includes(anchor)) {
      log('!! desktop: 未找到插入点');
    } else {
      const block = `  /*
   * ---- 播放历史上报 ----
   *
   * 上报失败不该影响播放，所以这里**吞掉异常并返回 ok:false**，
   * 而不是抛给渲染进程 —— 界面上的 await 也就不需要包 try。
   */
  ipcMain.handle(
    'historyUpload',
    wrap('historyUpload', async (mxid) => {
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

` + anchor;
      t = t.replace(anchor, block);
      fs.writeFileSync(f, t);
      log('ok: desktop IPC');
    }
  }
}

// ---------- ③ preload ----------
{
  const f = path.join(root, 'apps', 'desktop', 'preload.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('historyUpload:')) {
    log('preload: 已存在');
  } else {
    t = t.replace(
      `  /** 私人 FM（返回一批歌，前端排进队列一首首放） */`,
      `  /** 上报一次播放事件（酷狗只记"听了这首歌"，不记进度） */
  historyUpload: (mxid) => ipcRenderer.invoke('historyUpload', mxid),

  /** 私人 FM（返回一批歌，前端排进队列一首首放） */`
    );
    fs.writeFileSync(f, t);
    log('ok: preload');
  }
}

console.log('done');
