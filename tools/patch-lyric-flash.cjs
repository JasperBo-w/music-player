/*
 * 修「按中键只闪一下」。
 *
 * 用户的描述是决定性的：**"按下去就闪一下提示词"** ——
 * 提示闪一下 = 锁上又立刻解开 = 一次按键被切了两次。
 *
 * 两条路径：
 *   ① 窗口没锁时，光标在歌词上 → 窗口捕获鼠标 → **页面里的 mousedown**
 *      （button===1）触发 → 上锁。这是我很早加的。
 *   ② **同一个按键**又被全局监听（PowerShell 读 GetAsyncKeyState）收到 →
 *      setLyricLock(!lyricLocked) → 又切回解锁。
 *
 * 我加的 300ms 去抖在 onGlobalMiddleClick 里，**挡不住 ①** ——
 * 因为 ① 走的是 IPC，是另一条路径。
 *
 * 修法：
 *   · 删掉页面里的中键处理（全局监听已经覆盖它，而且锁定时也能用）
 *   · 把去抖**搬进唯一的写入口 setLyricLock** ——
 *     这样不管有几个来源重复触发，都会被同一道闸拦住
 *
 * 这是"状态只留一个写入口"的完整版：光合并写入口还不够，
 * 去抖这类"时序保护"也必须放在入口里，否则每条路径各加各的，
 * 早晚会漏掉一条（这次就是）。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const lyricFile = path.join(root, 'apps', 'ui', 'lyric.html');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① 删掉页面里的中键处理 ----------
{
  let t = readNorm(lyricFile);
  const old = t.slice(
    t.indexOf("      /*\n       * 中键：切换锁定 / 穿透。"),
    t.indexOf("      document.body.addEventListener('dblclick'")
  );
  if (old && old.includes("e.button === 1")) {
    t = t.replace(
      old,
      `      /*
       * ★ 这里**不要**再处理中键了。
       *
       * 曾经在这里绑过 mousedown(button===1) → toggleLock()。
       * 但中键同时被主进程的全局监听（PowerShell 读 GetAsyncKeyState）
       * 收着，于是**一次按键被切了两次**：这条把它锁上、那条又解开，
       * 用户看到的就是"提示词闪一下"。
       *
       * 全局监听能覆盖这个场景（而且**锁定时也能用** —— 那正是它的意义），
       * 所以页面这条是多余的，留着只会互相抵消。
       */

`
    );
    writeNorm(lyricFile, t);
    log('ok: 删掉页面中键处理');
  } else {
    log('!! 没定位到页面中键处理');
  }
}

// ---------- ② 去抖搬进唯一入口 ----------
{
  let t = readNorm(mainFile);

  const oldFn = `function setLyricLock(on) {
  const next = !!on;
  if (next === lyricLocked) return lyricLocked; // 无变化就不重复应用（也避免重复打日志）`;
  const newFn = `function setLyricLock(on) {
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
  lastLockAt = now;`;
  if (t.includes(oldFn)) {
    t = t.replace(oldFn, newFn);
    log('ok: 去抖进入口');
  } else {
    log('!! setLyricLock 没匹配');
  }

  // 时间戳变量
  t = t.replace(
    `let lastMiddleAt = 0;`,
    `let lastMiddleAt = 0;
/** 上一次**实际生效**的锁定切换时间，去抖用（见 setLyricLock） */
let lastLockAt = 0;`
  );

  // 中键那里原来的去抖可以留着（提前拦掉，少一次无谓调用），
  // 但把日志措辞区分开，免得和入口那条混淆
  t = t.replace(
    `  const now = Date.now();
  if (now - lastMiddleAt < 300) {
    console.log('[桌面歌词] 中键被忽略：300ms 内重复触发');
    return;
  }
  lastMiddleAt = now;
  setLyricLock(!lyricLocked);`,
    `  const now = Date.now();
  if (now - lastMiddleAt < 300) return; // 入口还有一道，这里只是少跑一次
  lastMiddleAt = now;
  setLyricLock(!lyricLocked);`
  );

  writeNorm(mainFile, t);
}

console.log('done');
