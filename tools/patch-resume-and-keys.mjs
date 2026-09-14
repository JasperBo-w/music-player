/*
 * 两件事：
 *
 * ① 窗口内单键快捷键（M/L/F）改成需要修饰键
 *
 * ② 记住上次关闭时的音乐状态，重开后恢复
 *
 * ① 的坑：Alt+M 已经是注册过的**全局热键**了。如果窗口内再留一条 Alt+M，
 *    窗口有焦点时两条都会触发 —— 静音切两次等于没切（而且看起来像"没反应"）。
 *    所以静音那条窗口内直接删掉，全局的负责；L/F 用 Alt 组合（目前没有全局冲突）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const f = path.join(path.dirname(here), 'apps', 'ui', 'src', 'main.js');
let t = fs.readFileSync(f, 'utf8');
const log = (m) => console.log(m);
const rep = (from, to, label) => {
  if (!t.includes(from)) {
    log('!! 未匹配: ' + label);
    return;
  }
  t = t.replace(from, to);
  log('ok: ' + label);
};

// ---------- ① 单键 → 需要修饰键 ----------
rep(
  `  if (e.key === 'm' || e.key === 'M') $('#vol-btn').click();
  if (e.key === 'l' || e.key === 'L') cyclePlayMode();
  if (e.key === 'f' || e.key === 'F') void toggleLike();`,
  `  /*
   * 单键快捷键改成需要 Alt。
   *
   * 原因：窗口有焦点时，光按 M/L/F 就触发 —— 太容易手滑。
   * 而且**静音那条必须删掉**：Alt+M 已经注册成全局热键了，
   * 窗口内再留一条 Alt+M 的话，有焦点时两条都会跑，
   * 静音被切两次 = 看起来完全没反应。全局那条负责静音就够了。
   */
  if (e.altKey && (e.key === 'l' || e.key === 'L')) cyclePlayMode();
  if (e.altKey && (e.key === 'f' || e.key === 'F')) void toggleLike();`,
  '① 单键改修饰键'
);

// ---------- ② 记忆音乐状态 ----------
rep(
  '/** 订阅主进程发回来的动作。重新注册时先退订，避免监听叠加。 */',
  `/* ------------------------------------------------------------------ */
/* 记住上次的音乐状态                                                  */
/* ------------------------------------------------------------------ */

const RESUME_KEY = 'mp.resume.v1';
/** 队列上限：只存前 300 首，免得 localStorage 被上千首撑爆 */
const RESUME_MAX_QUEUE = 300;

/**
 * 存一份"上次听到哪儿"。节流调用即可（定时 + 退出时各一次）。
 *
 * 为什么不每次 timeupdate 都存：那会每秒写好几次 localStorage，
 * 而 localStorage 是同步写、会卡主线程 —— 为了一个"恢复播放"不值当。
 */
function saveResume() {
  if (!state.currentSong) return;
  try {
    localStorage.setItem(
      RESUME_KEY,
      JSON.stringify({
        queue: state.queue.slice(0, RESUME_MAX_QUEUE),
        index: state.index,
        time: Number(audio.currentTime) || 0,
        volume: state.volume,
        muted: state.muted,
        playMode: state.playMode,
        savedAt: Date.now(),
      })
    );
  } catch {
    /* 配额满或隐私模式，忽略即可 */
  }
}

/**
 * 恢复上次的状态。
 *
 * 刻意**不自动播放**：开机就突然出声会吓人，而且用户多半不是马上想听。
 * 所以是"把歌和进度摆好、停在暂停"，按一下播放就能接着听。
 */
async function restoreResume() {
  let s = null;
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return false;
    s = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!s || !Array.isArray(s.queue) || !s.queue.length) return false;
  try {
    state.queue = s.queue;
    state.index = Math.max(0, Math.min(s.queue.length - 1, Number(s.index) || 0));
    if (s.playMode) state.playMode = s.playMode;
    renderQueue();
    await playAt(state.index, 'next', true);
    if (Number(s.time) > 1) {
      audio.currentTime = Number(s.time);
    }
    audio.pause();
    $('#pb-toggle').textContent = '▶';
    console.log('[恢复] 上次听到 ' + (s.queue[state.index] || {}).name + ' @ ' + Math.round(Number(s.time) || 0) + 's');
    return true;
  } catch (e) {
    console.warn('[恢复] 失败:', (e && e.message) || e);
    return false;
  }
}

/** 订阅主进程发回来的动作。重新注册时先退订，避免监听叠加。 */`,
  '② 加入恢复模块'
);

// 在末尾启动恢复 + 定时存档
rep(
  `} catch (err) {
  console.error('[热键] 启动注册失败:', (err && err.message) || err);
}`,
  `} catch (err) {
  console.error('[热键] 启动注册失败:', (err && err.message) || err);
}

/*
 * 恢复上次的音乐状态 + 定期存档。
 *
 * 定时 5 秒一次：足够精确（最多丢 5 秒进度），又不会像 timeupdate
 * 那样每秒写好几次同步的 localStorage。退出时再补存一次。
 */
void restoreResume();
setInterval(saveResume, 5000);
window.addEventListener('beforeunload', saveResume);`,
  '③ 启动恢复 + 定时存档'
);

// 暂停/切歌时也存一次（及时性好一些）
rep(
  `  if (bg) bg.setPlaying(false);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});`,
  `  if (bg) bg.setPlaying(false);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  // 暂停是个明确的"我就停在这儿"动作，立刻存档，别等定时器
  saveResume();
});`,
  '④ 暂停时立刻存档'
);

fs.writeFileSync(f, t);
console.log('done');
