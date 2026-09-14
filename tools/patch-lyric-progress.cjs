/*
 * 桌面歌词的进度改成**连续值**（按时间插值），不再用"已唱字数"。
 *
 * 起因：用户问"为什么赏是灰色的"。
 *
 * 查下来是这样：我推给歌词窗口的进度是**整数个字**（6/7），
 * 于是渐变擦除的分界线只能落在字与字之间 ——
 * 最后一个字要等整句唱完（7/7）才会亮，在那之前一直显示成灰色。
 * 而且整条光是**一格一格跳**的，不是扫过去的。
 *
 * Mineradio 推的是**当前行的时间进度**（连续百分比），所以光能平滑扫过。
 * 我们这边的歌词数据其实也能算：lyrics.js 里 this.flat = [{t, line}]，
 * **每个字都有自己的时间戳**（逐字歌词），所以可以插值到字内部：
 *
 *     frac     = (now - 当前字.t) / (下一个字.t - 当前字.t)      // 0~1
 *     progress = (已唱字数 + frac) / 该行总字数
 *
 * 这样最后一字在它**被唱的那一瞬间**就开始亮，而不是等整句结束。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const lyricFile = path.join(root, 'apps', 'ui', 'src', 'lyrics.js');
const uiFile = path.join(root, 'apps', 'ui', 'src', 'main.js');
const htmlFile = path.join(root, 'apps', 'ui', 'lyric.html');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① lyrics.js：加一个"当前行连续进度" ----------
{
  let t = readNorm(lyricFile);
  if (t.includes('lineProgress(')) {
    log('lyrics.js：已存在');
  } else {
    const anchor = `  /** 把活动行滚到容器中间 */`;
    const method = `  /**
   * 当前行的**连续**进度，0~1。
   *
   * 为什么需要它：桌面歌词的渐变擦除要一个连续的分界位置。
   * 只用"已唱到第几个字"（整数）的话，分界只能落在字与字之间 ——
   * 最后一个字要等整句唱完才亮，而且光是跳着走的，不是扫过去的。
   *
   * 数据是够的：this.flat 里**每个字都有时间戳**，所以在字内部插值即可。
   *
   * @param {number} timeSec 当前播放位置（秒）
   * @returns {number} 0~1；返回 -1 表示"当前没有可显示的歌词行"
   */
  lineProgress(timeSec) {
    const n = this.flat.length;
    if (!n || this.activeLine < 0) return -1;

    // 当前行在 flat 里的下标区间 [start, end]
    let start = 0;
    while (start < n && this.flat[start].line < this.activeLine) start++;
    if (start >= n || this.flat[start].line !== this.activeLine) return -1;
    let end = start;
    while (end + 1 < n && this.flat[end + 1].line === this.activeLine) end++;

    const total = end - start + 1;
    const idx = this.cursor;
    if (idx < start) return 0; // 这一行还没开始
    if (idx >= end) return 1; // 这一行已经唱完

    // 在"当前字"和"下一个字"之间按时间插值
    const t = timeSec - this.offset;
    const t0 = this.flat[idx].t;
    const t1 = this.flat[idx + 1].t;
    const frac = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;

    return Math.min(1, Math.max(0, (idx - start + 1 + frac) / total));
  }

${anchor}`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, method);
      writeNorm(lyricFile, t);
      log('ok: lyrics.js lineProgress');
    } else {
      log('!! lyrics.js 没找到锚点');
    }
  }
}

// ---------- ② main.js：推 progress ----------
{
  let t = readNorm(uiFile);
  if (t.includes('progress,')) {
    log('main.js：已存在');
  } else {
    const oldPush = `    void window.api.desktopLyric.push({
      text: line || (song ? song.name : ''),
      next,
      lit,`;
    const newPush = `    /*
     * 连续进度：0~1；-1 表示"显示的不是歌词行"（比如歌名）。
     * 优先取按时间插值的值，拿不到就退回"已唱字数/总字数"。
     */
    let progress = -1;
    try {
      if (line && audio && Number.isFinite(audio.currentTime)) {
        progress = lyricView.lineProgress(audio.currentTime);
      }
    } catch {}
    if (progress < 0 && lit >= 0 && line) {
      progress = Math.min(1, lit / Math.max(1, Array.from(line).length));
    }

    void window.api.desktopLyric.push({
      text: line || (song ? song.name : ''),
      next,
      lit,
      progress,`;
    if (t.includes(oldPush)) {
      t = t.replace(oldPush, newPush);
      writeNorm(uiFile, t);
      log('ok: main.js 推 progress');
    } else {
      log('!! main.js push 段没匹配');
    }
  }
}

// ---------- ③ lyric.html：优先用 progress ----------
{
  let t = readNorm(htmlFile);
  const old = `        let prog = 1;
        if (p.lit != null && p.lit >= 0) {
          const total = Math.max(1, Array.from(text).length);
          prog = Math.min(1, p.lit / total);
        }`;
  const neu = `        /*
         * 优先用**连续进度**（p.progress，按时间插值）。
         * 退回"已唱字数/总字数"只是一道保险 —— 那个是整数的，
         * 会让光一格一格跳、最后一个字要等整句唱完才亮。
         */
        let prog = 1;
        if (p.progress != null && p.progress >= 0) {
          prog = Math.min(1, p.progress);
        } else if (p.lit != null && p.lit >= 0) {
          const total = Math.max(1, Array.from(text).length);
          prog = Math.min(1, p.lit / total);
        }`;
  if (t.includes(old)) {
    t = t.replace(old, neu);
    writeNorm(htmlFile, t);
    log('ok: lyric.html 用 progress');
  } else {
    log('!! lyric.html 进度段没匹配');
  }
}

console.log('done');
