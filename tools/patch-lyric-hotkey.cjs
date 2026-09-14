/*
 * 桌面歌词的全局快捷键：Alt+D。
 *
 * 为什么不用 Alt+L：那个键已经被**窗口内**的"切换播放模式"占了。
 * 如果再加一条全局的 Alt+L，窗口有焦点时两条都会跑 ——
 * 按一下既切播放模式又开关桌面歌词。这正是我在热键那一块
 * 特意记过的坑（"一次按键触发两次"），不能再犯一次。
 *
 * 做成全局热键表里的一条，好处是：设置 → 热键 里能直接改，
 * 而且注册失败会显示"被占用"，不用另写一套。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'main.js');
let t = fs.readFileSync(f, 'utf8');
const log = (m) => console.log(m);

// ① 动作表里加一条
const listAnchor = "  { id: 'mute', label: '静音开关', def: 'Alt+M' },";
if (t.includes("id: 'lyric'")) {
  log('动作表已有 lyric');
} else if (t.includes(listAnchor)) {
  t = t.replace(
    listAnchor,
    listAnchor + "\n  // Alt+D（Desktop）：Alt+L 被窗口内的「播放模式」占了，不能重复\n  { id: 'lyric', label: '桌面歌词开关', def: 'Alt+D' },"
  );
  log('ok: 动作表加 lyric');
} else {
  log('!! 未找到动作表锚点');
}

// ② 动作分发里加一个分支
const caseAnchor = `    case 'mute':
      /*
       * 直接复用音量按钮那条路径，不要自己手搓。`;
const newCase = `    case 'lyric':
      // 桌面歌词：复用播放条那个按钮同一条路径（它会回读真实状态再切换）
      void toggleDesktopLyric();
      break;
    case 'mute':
      /*
       * 直接复用音量按钮那条路径，不要自己手搓。`;
if (t.includes("case 'lyric':")) {
  log('分发已有 lyric');
} else if (t.includes(caseAnchor)) {
  t = t.replace(caseAnchor, newCase);
  log('ok: 动作分发加 lyric');
} else {
  log('!! 未找到 case mute 锚点');
}

fs.writeFileSync(f, t);
console.log('done');