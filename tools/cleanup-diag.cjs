/*
 * 清理排查期间加的诊断代码。
 *
 * 这一晚为了定位问题加了不少探针，现在问题解决了，要清掉 ——
 * 特别是**每次 moveBy 都打一行日志**那个：拖动时每秒上百行，
 * 既刷屏又白白占用 I/O。留着就是负债。
 *
 * 保留的：
 *   · lyric:where —— 这个很有用（能一眼看出文字在哪、穿透状态如何），
 *     而且是按需调用，不产生常驻开销
 *   · 判定被忽略时的那条日志 —— 低频率，而且下次出问题能救命
 *
 * 清掉的：
 *   · moveBy 到达日志（每次移动一行）
 *   · 每 4 秒的拖动汇总
 *   · dragStart / dragEnd 日志
 *   · 穿透状态改变日志
 *   · 歌词页的 pointerdown 日志
 *   · 已经不用的合并位移代码（applyPendingLyricMove 等）
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const lyricFile = path.join(root, 'apps', 'ui', 'lyric.html');
const log = (m) => console.log(m);

function clean(file, rules) {
  let t = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  let n = 0;
  for (const [label, re] of rules) {
    const before = t.length;
    t = t.replace(re, '');
    if (t.length !== before) n++;
    else log('  (没匹配) ' + label);
  }
  fs.writeFileSync(file, t.replace(/\n/g, '\r\n'));
  return n;
}

// ---------- 主进程 ----------
{
  const n = clean(mainFile, [
    [
      'moveBy 到达日志',
      /    \/\*\n     \* 诊断日志打在\*\*守卫之前\*\*。[\s\S]*?\n     \*\/\n    console\.log\(\n      '\[诊断\] moveBy 到达 dx=' \+ dx \+ ' dy=' \+ dy \+\n        ' 窗口=' \+ \(lyricWindow \? \(lyricWindow\.isDestroyed\(\) \? '已销毁' : '正常'\) : '空'\)\n    \);\n/,
    ],
    [
      'dragStart 日志',
      /    console\.log\('\[诊断\] dragStart 收到，冻结穿透判定'\);\n/,
    ],
    [
      'dragEnd 日志',
      /    console\.log\('\[诊断\] dragEnd 收到，共收到 moveBy ' \+ dragStats\.moves \+ ' 次'\);\n/,
    ],
    [
      '穿透状态改变日志',
      /  \/\*\n   \* ★ 只有\*\*真正改变\*\*时才到这里。[\s\S]*?\n   \*\/\n  console\.log\(\n    '\[诊断\] 穿透状态改变 →',\n    shouldIgnore \? '穿透' : '可交互',\n    '拖动中=' \+ lyricDragging,\n    'dragStats=' \+ JSON\.stringify\(dragStats\)\n  \);\n/,
    ],
    [
      '拖动汇总定时器',
      /\/\* -+ \*\/\n\/\* 拖动诊断：每 4 秒汇总一次 moveBy 的量与耗时[\s\S]*?\n\}, 4000\);\n/,
    ],
  ]);
  log('主进程清理 ' + n + ' 处');
}

// ---------- 歌词页 ----------
{
  const n = clean(lyricFile, [
    [
      'pointerdown 日志',
      /        \/\*\n         \* ★ 诊断：记录每一个到达页面的 pointerdown。[\s\S]*?\n         \*\/\n        console\.log\(\n          '\[歌词·指针\] pointerdown button=' \+ e\.button \+\n            ' at ' \+ Math\.round\(e\.clientX\) \+ ',' \+ Math\.round\(e\.clientY\)\n        \);\n/,
    ],
  ]);
  log('歌词页清理 ' + n + ' 处');
}

console.log('done');
