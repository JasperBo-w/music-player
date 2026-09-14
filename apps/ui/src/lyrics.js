/**
 * 歌词引擎
 *
 * 酷狗返回的是 KRC 格式（逐字时间轴），解码后的文本长这样：
 *
 *   [id:$00000000]
 *   [ti:岸]
 *   [ar:初音未来 (初音ミク)/墨蓝酱油]
 *   [0,9765]<0,610,0>岸<610,610,0> - <1221,610,0>初<1831,610,0>音…
 *
 * 结构是：行头 [起始ms,该行时长] + 若干 <段内偏移ms,段时长ms,0>文本 片段。
 * 一个片段里的多个字是均分这段时间的，展开成逐字时间轴即可做逐字点亮。
 *
 * 也兼容普通 LRC：[mm:ss.xx]整行文本（无逐字，按整行点亮）
 *
 * 渲染性能约定：
 *   - DOM 只在 setLyrics 时构建一次，之后每帧只切换 class
 *   - 时间单调递增，用一个游标指针增量推进，不做二分/全量扫描
 *   - 只在活动行变化时才滚动，避免每帧触发布局
 */

/** 解析 [key:value] 元数据行 */
function parseMeta(text) {
  const meta = {};
  const re = /^\[([a-zA-Z#$]+):(.*)\]$/;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (m) meta[m[1]] = m[2];
  }
  return meta;
}

/**
 * 解析 KRC
 * @param {string} text 解码后的歌词文本
 * @returns {{meta: object, lines: Array, wordByWord: boolean}}
 */
export function parseKrc(text) {
  const meta = parseMeta(text);
  const lines = [];

  // 行头：[起始ms,时长ms] 后面跟着一串 <偏移,时长,0>文本
  const lineRe = /^\[(\d+),(\d+)\](.*)$/;
  const segRe = /<(\d+),(\d+),(\d+)>([^<]*)/g;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const lm = lineRe.exec(line);
    if (!lm) continue;

    const startMs = Number(lm[1]);
    const durMs = Number(lm[2]);
    const rest = lm[3];

    const chars = [];
    segRe.lastIndex = 0;
    let sm;
    while ((sm = segRe.exec(rest)) !== null) {
      const segOffset = Number(sm[1]);
      const segDur = Number(sm[2]);
      const segText = sm[4];
      if (!segText) continue;

      // 片段里的字均分这段时间
      const n = segText.length;
      const per = n > 0 ? segDur / n : 0;
      for (let i = 0; i < n; i++) {
        chars.push({
          t: (startMs + segOffset + per * i) / 1000,
          d: per / 1000,
          ch: segText[i],
        });
      }
    }

    // 没有片段信息（纯 LRC 混在 KRC 里）时，整行当一段
    if (chars.length === 0 && rest.trim()) {
      const n = rest.length;
      const per = durMs / Math.max(1, n);
      for (let i = 0; i < n; i++) {
        chars.push({ t: (startMs + per * i) / 1000, d: per / 1000, ch: rest[i] });
      }
    }

    if (chars.length) {
      lines.push({
        start: startMs / 1000,
        end: (startMs + durMs) / 1000,
        text: chars.map((c) => c.ch).join(''),
        chars,
      });
    }
  }

  lines.sort((a, b) => a.start - b.start);
  return { meta, lines, wordByWord: true };
}

/** 解析普通 LRC */
export function parseLrc(text) {
  const meta = parseMeta(text);
  const lines = [];
  const re = /^\[(\d+):(\d+(?:[.:]\d+)?)\](.*)$/;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = re.exec(raw.trim());
    if (!m) continue;
    const start = Number(m[1]) * 60 + Number(m[2].replace(':', '.'));
    const content = m[3].trim();
    if (!content) continue;

    // 无逐字信息，按每字 0.28 秒估一个近似逐字时间，视觉上比整行跳变更自然
    const chars = [];
    const per = 0.28;
    for (let i = 0; i < content.length; i++) {
      chars.push({ t: start + per * i, d: per, ch: content[i] });
    }
    lines.push({ start, end: start + per * content.length, text: content, chars });
  }

  lines.sort((a, b) => a.start - b.start);
  return { meta, lines, wordByWord: false };
}

/** 自动判断格式并解析 */
export function parseLyrics(text, isWordByWord) {
  const t = String(text || '');
  if (isWordByWord || /<\d+,\d+,\d+>/.test(t)) return parseKrc(t);
  return parseLrc(t);
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

export class LyricView {
  /**
   * @param {HTMLElement} container 歌词容器（会被整体接管）
   * @param {object} [opts]
   * @param {boolean} [opts.wordByWord] 是否逐字点亮，否则整行点亮
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.wordByWord = opts.wordByWord !== false;
    this.offset = 0; // 时间轴偏移（秒），正数表示歌词提前
    this.lines = [];
    this.lineEls = [];
    /** 扁平化的所有字，带各自所属行号，用于增量推进游标 */
    this.flat = [];
    this.cursor = -1;
    this.activeLine = -1;
    this.empty = container.querySelector('.lyric-empty') || null;
    container.classList.add('lyric-view');
  }

  /** 设置时间轴偏移（秒）。正数 = 歌词提前出现 */
  setOffset(sec) {
    this.offset = Number(sec) || 0;
    // 偏移变了要重算游标，下次 update 从当前位置附近重新对齐
    this.cursor = -1;
    this.activeLine = -1;
  }

  getOffset() {
    return this.offset;
  }

  clear(message = '还没有在播放的歌曲') {
    this.container.innerHTML = `<div class="lyric-empty">${message}</div>`;
    this.lines = [];
    this.lineEls = [];
    this.flat = [];
    this.cursor = -1;
    this.activeLine = -1;
  }

  /**
   * 装载歌词并构建 DOM（只在换歌时调用）
   * @param {ReturnType<typeof parseLyrics>} parsed
   */
  setLyrics(parsed) {
    const lines = (parsed && parsed.lines) || [];
    if (!lines.length) {
      this.clear('这首歌没有歌词');
      return 0;
    }

    this.lines = lines;
    this.wordByWord = parsed.wordByWord !== false;
    this.cursor = -1;
    this.activeLine = -1;
    this.flat = [];
    this.lineEls = [];

    const frag = document.createDocumentFragment();

    lines.forEach((line, li) => {
      const row = document.createElement('div');
      row.className = 'lyric-row';

      const inner = document.createElement('div');
      inner.className = 'lyric-line';

      for (const c of line.chars) {
        const span = document.createElement('span');
        span.className = 'lyric-char';
        span.textContent = c.ch;
        inner.appendChild(span);
        this.flat.push({ t: c.t, line: li });
      }

      row.appendChild(inner);
      frag.appendChild(row);
      this.lineEls.push(row);
    });

    this.container.innerHTML = '';
    this.container.appendChild(frag);
    return lines.length;
  }

  /**
   * 按当前播放时间更新高亮与滚动
   * @param {number} timeSec 当前播放位置（秒）
   */
  update(timeSec) {
    if (!this.flat.length) return;

    const t = timeSec - this.offset;

    // ---- 找当前应该点亮到第几个字（时间单调递增，从游标增量推进）----
    let idx = this.cursor;
    if (idx < 0) {
      // 跳转（拖动进度条）后需要重新定位：线性找一次即可，歌词总量很小
      idx = 0;
      while (idx < this.flat.length && this.flat[idx].t <= t) idx++;
      idx--;
    } else {
      while (idx + 1 < this.flat.length && this.flat[idx + 1].t <= t) idx++;
      while (idx >= 0 && this.flat[idx].t > t) idx--;
    }

    if (idx === this.cursor) return;
    this.cursor = idx;

    // ---- 切换已点亮/未点亮的字 ----
    // 只动变化的那一段，不是全量刷新
    const spans = this.container.querySelectorAll('.lyric-char');
    if (idx >= 0) {
      for (let i = Math.max(0, this._lastIdx ?? -1) + 1; i <= idx; i++) {
        const s = spans[i];
        if (s) s.classList.add('on');
      }
    }
    // 往回跳（拖动进度条）时清掉多余的
    for (let i = idx + 1; i <= (this._lastIdx ?? -1); i++) {
      const s = spans[i];
      if (s) s.classList.remove('on');
    }
    this._lastIdx = idx;

    // ---- 活动行 ----
    const activeLine = idx >= 0 ? this.flat[idx].line : 0;
    if (activeLine !== this.activeLine) {
      const prev = this.lineEls[this.activeLine];
      if (prev) prev.classList.remove('active');
      const cur = this.lineEls[activeLine];
      if (cur) {
        cur.classList.add('active');
        // 只在换行时滚动，不动每帧触发
        this._scrollTo(cur);
      }
      this.activeLine = activeLine;
    }
  }

  /**
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

  /** 把活动行滚到容器中间 */
  _scrollTo(el) {
    const box = this.container;
    const target = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
}
