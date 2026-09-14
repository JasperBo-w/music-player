/*
 * 桌面歌词的文字效果对齐软件内。
 *
 * 软件内（styles.css 的 .lyric-char / .lyric-char.on）是这样：
 *   · 没唱到的字：var(--muted)，暗
 *   · 唱到的字：**var(--accent-ink) + 柔光** text-shadow 0 0 14px rgba(accent-rgb,.55)
 * 这是个"逐字点亮"的效果，光把整句文本推过去是做不出来的。
 *
 * 所以推给歌词窗口的数据要加三样：
 *   lit       —— 这一句已经唱到第几个字
 *   accent    —— 强调色（歌词窗口没有主界面的 CSS 变量，必须跟着数据走）
 *   accentRgb —— "r,g,b" 形式，用来拼柔光
 *
 * 为什么强调色要**跟着数据走**而不是在歌词窗口里自己定：
 * 主界面的强调色会随封面变（"配色跟着封面走"），歌词窗口必须跟着一起变，
 * 否则两块屏幕上的歌词会不同色 —— 那就不是"跟软件内一样"了。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const log = (m) => console.log(m);

// ---------- ① 渲染进程：多推 lit / accent / accentRgb ----------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'main.js');
  let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  if (t.includes('lit:')) {
    log('渲染进程：已存在');
  } else {
    const old = `  if (window.api && window.api.desktopLyric) {
    let next = '';
    try {
      const nEl = lyricView.lineEls && lyricView.lineEls[lyricView.activeLine + 1];
      if (nEl) next = String(nEl.textContent || '').trim();
    } catch {}
    void window.api.desktopLyric.push({
      text: line || (song ? song.name : ''),
      next,
      title: song ? song.name : '',
      artist: song ? song.artist || '' : '',
    });
  }`;
    const neu = `  if (window.api && window.api.desktopLyric) {
    let next = '';
    /*
     * 已唱到第几个字：直接数当前行里 .on 的字符数。
     * **不要去重新解析歌词的时间轴** —— 软件内显示到第几个字，
     * 是 lyricView 算出来的那一份，这里照抄它才不会两边不一致。
     */
    let lit = -1;
    try {
      const nEl = lyricView.lineEls && lyricView.lineEls[lyricView.activeLine + 1];
      if (nEl) next = String(nEl.textContent || '').trim();
      const el = lyricView.lineEls && lyricView.lineEls[lyricView.activeLine];
      if (el) lit = el.querySelectorAll('.lyric-char.on').length;
    } catch {}

    /*
     * 强调色要跟着数据走：主界面的强调色会随封面变（"配色跟着封面走"），
     * 歌词窗口没有这套 CSS 变量，只能由这边算好推过去 ——
     * 否则桌面上的歌词和软件内的歌词会不同色。
     */
    let accent = '';
    let accentRgb = '';
    try {
      const cs = getComputedStyle(document.documentElement);
      accent = (cs.getPropertyValue('--accent-ink') || cs.getPropertyValue('--accent') || '').trim();
      accentRgb = (cs.getPropertyValue('--accent-rgb') || '').trim();
    } catch {}

    void window.api.desktopLyric.push({
      text: line || (song ? song.name : ''),
      next,
      lit,
      accent,
      accentRgb,
      title: song ? song.name : '',
      artist: song ? song.artist || '' : '',
    });
  }`;
    if (t.includes(old)) {
      t = t.replace(old, neu);
      fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
      log('ok: 渲染进程推 lit/accent');
    } else {
      log('!! 渲染进程那段没匹配');
    }
  }
}

// ---------- ② 歌词窗口：逐字渲染 ----------
{
  const f = path.join(root, 'apps', 'ui', 'lyric.html');
  let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

  // 样式：加逐字染色 + 用主界面推来的强调色
  if (!t.includes('.ch.on')) {
    t = t.replace(
      `      #next {`,
      `      /*
       * 逐字点亮 —— 和软件内 .lyric-char / .lyric-char.on 同一套做法：
       * 没唱到的字暗，唱到的字用强调色 + 柔光。
       * 强调色由主界面推来（--lyric-accent），因为它会随封面变。
       */
      #main .ch {
        color: rgba(255, 255, 255, 0.66);
        transition: color 0.16s, text-shadow 0.16s;
      }
      #main .ch.on {
        color: var(--lyric-accent, #fff);
        /* 柔光叠在原来的黑描边之上，保证浅色桌面上也不糊 */
        text-shadow:
          -1.5px -1.5px 0 rgba(0, 0, 0, 0.85),
          1.5px -1.5px 0 rgba(0, 0, 0, 0.85),
          -1.5px 1.5px 0 rgba(0, 0, 0, 0.85),
          1.5px 1.5px 0 rgba(0, 0, 0, 0.85),
          0 0 16px var(--lyric-glow, rgba(255, 255, 255, 0.5));
      }

      #next {`
    );
    log('ok: 歌词窗口样式');
  }

  // 渲染逻辑：拆成逐字 span
  if (!t.includes('escChar')) {
    const old = `      window.api.desktopLyric.onUpdate((payload) => {
        const p = payload || {};
        mainEl.textContent = p.text || (p.title ? p.title : '♪');
        nextEl.textContent = p.next || '';
      });`;
    const neu = `      /** 转义：歌词文本来自网络接口，必须转义后再拼进 innerHTML */
      const escChar = (c) =>
        c.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

      /** 上一帧渲染的内容，用来避免每帧重建 DOM（歌词每秒更新多次） */
      let lastKey = '';

      window.api.desktopLyric.onUpdate((payload) => {
        const p = payload || {};
        const text = p.text || (p.title ? p.title : '♪');

        // 强调色跟着主界面走
        if (p.accent) document.documentElement.style.setProperty('--lyric-accent', p.accent);
        if (p.accentRgb) {
          document.documentElement.style.setProperty('--lyric-glow', 'rgba(' + p.accentRgb + ', .55)');
        }

        /*
         * lit < 0 表示"没有逐字信息"（比如纯音乐显示的其实是歌名）——
         * 这时整句都用强调色，而不是全暗，否则看起来像没在唱。
         */
        const chars = Array.from(text);
        const lit = p.lit == null || p.lit < 0 ? chars.length : p.lit;
        const key = text + '|' + lit;
        if (key !== lastKey) {
          lastKey = key;
          mainEl.innerHTML = chars
            .map((c, i) => '<span class="ch' + (i < lit ? ' on' : '') + '">' + escChar(c) + '</span>')
            .join('');
        }

        if (nextEl.textContent !== (p.next || '')) nextEl.textContent = p.next || '';
      });`;
    if (t.includes(old)) {
      t = t.replace(old, neu);
      log('ok: 歌词窗口逐字渲染');
    } else {
      log('!! 歌词窗口那段没匹配');
    }
  }

  fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
}

console.log('done');
