/*
 * 桌面歌词的正文效果：去掉硬描边，改成多层模糊辉光 + 节拍响应。
 *
 * 起因：用户截图给我看 Mineradio 的效果，说"这种啊，沉浸效果，效果非常好"。
 *
 * 它的做法（public/desktop-lyrics.html drawGlowText，945 行）是 canvas 画
 * **四层由近到远的模糊描边**，用 globalCompositeOperation='lighter' 叠加：
 *
 *     { blur:10, alpha:.54 }   // 紧实的内晕
 *     { blur:24, alpha:.38 }
 *     { blur:48, alpha:.20 }
 *     { blur:78, alpha:.09 }   // 散得很远的柔光
 *
 * 而且强度由 live.solar + live.beat 驱动 —— **鼓点一来整圈晕会涨**。
 *
 * 我原来用的是 -webkit-text-stroke: 2px 的黑边，那看着像描红，
 * 和"沉浸"完全不沾边。
 *
 * CSS 里的等效做法是**链式 drop-shadow**（每一层会模糊上一层的输出，
 * 所以天然是"越往外越散"）。再加上主界面推来的节拍值调制半径。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const htmlFile = path.join(root, 'apps', 'ui', 'lyric.html');
const uiFile = path.join(root, 'apps', 'ui', 'src', 'main.js');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① 歌词窗口：链式辉光替换硬描边 ----------
{
  let t = readNorm(htmlFile);

  // 1.1 新增辉光强度变量
  t = t.replace(
    `        --lyric-edge: 60px;`,
    `        --lyric-edge: 60px;
        /* 辉光强度：由主界面推来的节拍值调制，1 是常态 */
        --lyric-glow-k: 1;`
  );

  // 1.2 去掉硬描边，换成"一层暗底 + 多层彩色辉光"
  const oldFilter = `        -webkit-text-stroke: 2px rgba(0, 0, 0, 0.72);
        paint-order: stroke fill;
        filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.6)) drop-shadow(0 0 14px rgba(0, 0, 0, 0.5));`;
  const newFilter = `        /*
         * ★ 不用 -webkit-text-stroke。
         *
         * 2px 的硬黑边看着像描红，和"沉浸"是两个东西。
         * Mineradio 用的是**多层模糊描边**（canvas 上画四层 blur 10/24/48/78）。
         * CSS 里的等效写法是链式 drop-shadow —— 每一层会模糊上一层的输出，
         * 于是自然形成"内紧外散"的一圈光晕。
         *
         * 第一层是**暗色**的（保证浅色壁纸上也能读），
         * 后面三层才是彩色辉光（--lyric-glow，跟着封面走）。
         * 半径乘 --lyric-glow-k：主界面把当前节拍值推过来，鼓点一来整圈会涨。
         */
        filter: drop-shadow(0 1px 2.5px rgba(4, 6, 12, 0.72))
          drop-shadow(0 0 calc(4px * var(--lyric-glow-k)) var(--lyric-glow, rgba(255, 255, 255, 0.4)))
          drop-shadow(0 0 calc(11px * var(--lyric-glow-k)) var(--lyric-glow, rgba(255, 255, 255, 0.35)))
          drop-shadow(0 0 calc(26px * var(--lyric-glow-k)) var(--lyric-glow, rgba(255, 255, 255, 0.3)));`;
  if (t.includes(oldFilter)) {
    t = t.replace(oldFilter, newFilter);
    log('ok: 辉光替换描边');
  } else {
    log('!! filter 那段没匹配');
  }

  // 1.3 描边本来负责"字形轮廓"，去掉后靠 padding 撑开避免辉光被裁
  t = t.replace(
    `      #main {
        max-width: calc(100vw - 24px);`,
    `      #main {
        /* 留出辉光的余量，否则最外那层会被容器裁掉 */
        padding: 0 34px;
        max-width: calc(100vw - 24px);`
  );

  // 1.4 接收节拍值
  t = t.replace(
    `        requestAnimationFrame(reportHot);`,
    `        /*
         * 节拍：主界面把当前的能量/鼓点值推过来（0~1），
         * 映射到 0.7~1.7 的辉光倍数 —— 鼓点一来整圈晕会涨。
         * 不做平滑：主界面那边本来就是平滑过的值，
         * 这里再平滑一次会让它慢半拍，反而失去"跟拍"的感觉。
         */
        if (p.pulse != null) {
          const k = 0.7 + Math.min(1, Math.max(0, p.pulse)) * 1.0;
          root.style.setProperty('--lyric-glow-k', k.toFixed(3));
        }

        requestAnimationFrame(reportHot);`
  );

  writeNorm(htmlFile, t);
}

// ---------- ② main.js：把节拍值一并推过去 ----------
{
  let t = readNorm(uiFile);
  if (t.includes('pulse: pulseNow')) {
    log('main.js：已存在');
  } else {
    const old = `    void window.api.desktopLyric.push({
      text: line || (song ? song.name : ''),
      next,
      lit,
      progress,`;
    const neu = `    /*
     * 节拍值：直接取舞台那一份（bg.pulseValue）。
     * **不要去另算一个** —— 粒子背景的起伏、舞台文字的呼吸都是用它，
     * 桌面歌词如果用另一个来源，两边的"节拍"迟早会对不上，
     * 看起来就是"歌词和背景各跳各的"。
     */
    let pulseNow = 0;
    try {
      pulseNow = bg && Number.isFinite(bg.pulseValue) ? bg.pulseValue : 0;
    } catch {}

    void window.api.desktopLyric.push({
      text: line || (song ? song.name : ''),
      next,
      lit,
      progress,
      pulse: pulseNow,`;
    if (t.includes(old)) {
      t = t.replace(old, neu);
      writeNorm(uiFile, t);
      log('ok: main.js 推 pulse');
    } else {
      log('!! main.js push 段没匹配');
    }
  }
}

console.log('done');
