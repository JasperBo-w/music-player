/*
 * 移动窗口的开销：用高精度计时重测，并且做成**我自己能跑的基准**。
 *
 * 两个问题：
 *
 * ① 之前的 9.17ms 可能是**假数**。
 *    我用 Date.now() 计时，而 Windows 上它的分辨率是 15.6ms ——
 *    对一个真实开销不到 1ms 的操作取样平均，会得到 5~10ms 这种
 *    纯粹由量化噪声构成的"耗时"。**我拿它当结论，还据此推了好几轮。**
 *    → 换 performance.now()（亚毫秒分辨率）。
 *
 * ② 拖动卡顿这件事我一直没法自己测（按不住鼠标）。
 *    但"移动窗口要多久"是**可以脱离拖动单独测的** ——
 *    加一条 lyric:bench：连续移动 N 次、量每次耗时、报告分布。
 *    这样我不用等人拖，就能知道到底是移动贵，还是别的东西贵。
 *
 * 基准还分两种状态测：
 *   · 页面正常（canvas 在跑、有辉光）
 *   · 页面极简（canvas 停、filter 去掉）
 * 两者一比，就知道"贵"是不是页面重绘造成的。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const preloadFile = path.join(root, 'apps', 'desktop', 'preload.js');
const lyricFile = path.join(root, 'apps', 'ui', 'lyric.html');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① 基准 IPC ----------
{
  let t = readNorm(mainFile);
  if (t.includes("'lyric:bench'")) {
    log('bench 已存在');
  } else {
    t = t.replace(
      `  ipcMain.handle('lyric:hotBounds'`,
      `  /*
   * 移动窗口的基准测试。
   *
   * 拖动卡顿我一直没法自己测（按不住鼠标），但"移动一次窗口要多久"
   * 是可以脱离拖动单独测的 —— 连续移动 40 次，量每次耗时，报告分布。
   *
   * 用 performance.now()（亚毫秒）而不是 Date.now()：
   * Windows 上后者的分辨率是 15.6ms，对不到 1ms 的操作取样平均，
   * 会得到 5~10ms 这种**纯量化噪声**构成的"耗时" —— 我上一轮就是被它骗了。
   */
  ipcMain.handle('lyric:bench', (_e, n) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return { error: 'NO_WINDOW' };
    const count = Math.max(1, Math.min(200, Number(n) || 40));
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
      n: count,
      avg: +(sum / count).toFixed(3),
      min: +samples[0].toFixed(3),
      p50: +samples[Math.floor(count / 2)].toFixed(3),
      max: +samples[count - 1].toFixed(3),
    };
  });

  ipcMain.handle('lyric:hotBounds'`
    );
    writeNorm(mainFile, t);
    log('ok: lyric:bench');
  }

  // 拖动计时也换成高精度
  let t2 = readNorm(mainFile);
  t2 = t2.replace(
    `  const t0 = Date.now();
  lyricWindow.setPosition(lyricPosX, lyricPosY);
  dragStats.moves++;
  dragStats.moveMs += Date.now() - t0;`,
    `  /*
   * 用 performance.now() 而不是 Date.now() ——
   * Windows 上 Date.now() 的分辨率是 15.6ms，对亚毫秒操作取平均
   * 会得出 5~10ms 的假耗时（上一轮就是被它骗的）。
   */
  const t0 = performance.now();
  lyricWindow.setPosition(lyricPosX, lyricPosY);
  dragStats.moves++;
  dragStats.moveMs += performance.now() - t0;`
  );
  writeNorm(mainFile, t2);
}

// ---------- ② preload ----------
{
  let t = readNorm(preloadFile);
  if (!t.includes('bench')) {
    t = t.replace(
      `    dragStart: () => ipcRenderer.invoke('lyric:dragStart'),`,
      `    /** 基准：连续移动窗口 N 次并报告耗时（诊断用） */
    bench: (n) => ipcRenderer.invoke('lyric:bench', n),
    dragStart: () => ipcRenderer.invoke('lyric:dragStart'),`
    );
    writeNorm(preloadFile, t);
    log('ok: preload bench');
  }
}

// ---------- ③ 页面：极简模式（供基准对比） ----------
{
  let t = readNorm(lyricFile);
  if (!t.includes('body.minimal')) {
    t = t.replace(
      `      #main {`,
      `      /*
       * 极简模式：供基准对比用。
       * 停掉 canvas、去掉辉光 filter —— 用来判断"移动窗口贵"到底是
       * 窗口本身（透明+置顶）的问题，还是页面重绘的问题。
       */
      body.minimal #fx {
        display: none;
      }
      body.minimal .glow {
        filter: none !important;
        contain: none;
      }

      #main {`
    );
    writeNorm(lyricFile, t);
    log('ok: 极简模式样式');
  }
}

console.log('done');
