/*
 * 桌面歌词的开关按钮（放在播放条上）。
 *
 * 为什么必须有这个按钮，而不是只靠"双击歌词窗口切穿透"：
 * 歌词窗口一旦被设为鼠标穿透，它就**收不到任何鼠标事件**了 ——
 * 包括"双击解锁"。所以必须有一个在它之外的入口。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const htmlFile = path.join(root, 'apps', 'ui', 'index.html');
const uiFile = path.join(root, 'apps', 'ui', 'src', 'main.js');
const cssFile = path.join(root, 'apps', 'ui', 'src', 'styles.css');
const log = (m) => console.log(m);

// ---------- ① 按钮 ----------
{
  const lines = fs.readFileSync(htmlFile, 'utf8').split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes('id="speed-chip"'));
  if (at < 0) {
    log('!! 没找到 speed-chip');
  } else if (lines.some((l) => l.includes('id="lyric-chip"'))) {
    log('按钮已存在');
  } else {
    // 插在倍速 chip-wrap 之前
    const start = at - 1;
    lines.splice(
      start,
      0,
      '        <button id="lyric-chip" class="chip" title="桌面歌词（独立置顶窗口）">词</button>'
    );
    fs.writeFileSync(htmlFile, lines.join('\r\n'));
    log('ok: 歌词开关按钮');
  }
}

// ---------- ② 逻辑 ----------
{
  let t = fs.readFileSync(uiFile, 'utf8');
  if (t.includes('function toggleDesktopLyric')) {
    log('逻辑已存在');
  } else {
    const block = [
      '/* ------------------------------------------------------------------ */',
      '/* 桌面歌词开关                                                        */',
      '/* ------------------------------------------------------------------ */',
      '',
      '/*',
      ' * 状态从主进程回读，而不是在渲染进程里自己记一份 ——',
      ' * 歌词窗口可能被别的方式打开/关闭（托盘、快捷键），',
      ' * 本地记一份迟早会和真实状态不一致，按钮就会显示成反的。',
      ' */',
      'async function syncLyricChip() {',
      '  if (!window.api || !window.api.desktopLyric) return;',
      '  try {',
      '    const on = await window.api.desktopLyric.visible();',
      "    $('#lyric-chip').classList.toggle('on', !!on);",
      '  } catch {}',
      '}',
      '',
      'async function toggleDesktopLyric() {',
      '  if (!window.api || !window.api.desktopLyric) return;',
      '  const on = await window.api.desktopLyric.visible();',
      '  await window.api.desktopLyric.toggle(!on);',
      '  await syncLyricChip();',
      '  // 开的时候立刻推一次当前歌词，不然要等到下一句才显示',
      '  if (!on) updateStageText();',
      '}',
      '',
      "$('#lyric-chip').addEventListener('click', () => void toggleDesktopLyric());",
      'void syncLyricChip();',
      '',
    ].join('\n');
    const anchor = "/* ------------------------------------------------------------------ */\n/* 系统媒体控制（SMTC / 媒体键）                                       */";
    const at = t.indexOf(anchor);
    if (at < 0) {
      log('!! 没找到插入点（媒体控制那段）');
    } else {
      // 行尾可能是 \n，统一处理：先按 \n 拆，再按原样拼
      const eol = t.includes('\r\n') ? '\r\n' : '\n';
      t = t.slice(0, at) + block.split('\n').join(eol) + t.slice(at);
      fs.writeFileSync(uiFile, t);
      log('ok: 歌词开关逻辑');
    }
  }
}

// ---------- ③ 样式：复用 .chip.on ----------
{
  let c = fs.readFileSync(cssFile, 'utf8');
  if (c.includes('#lyric-chip')) {
    log('样式已存在');
  } else {
    c += `

/* 桌面歌词开关：和倍速一样用 .chip.on 点亮 */
#lyric-chip { min-width: 30px; font-size: 13px; }
`;
    fs.writeFileSync(cssFile, c);
    log('ok: 样式');
  }
}

console.log('done');
