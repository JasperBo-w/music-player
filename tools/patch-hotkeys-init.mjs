/*
 * 修两件事：
 *
 * ① 启动时热键没注册 —— 不是 settings 的问题，是**暂时性死区**：
 *    bindHotkeyActions 内部引用的 hotkeyUnsub 是用 let 声明在我插入块的后面，
 *    而调用点在前面。let 的 TDZ 会抛 "Cannot access before initialization"，
 *    210 行一抛，211 行的 applyGlobalHotkeys 就永远不执行 ——
 *    而且因为写在 void 里，连报错都看不见。
 *    改法：内部状态用 var（提升、无死区）+ 把初始化挪到模块末尾。
 *
 * ② 初始化加显式 catch：以后这类错误会直接打在日志里，
 *    而不是变成"什么都没发生"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const f = path.join(path.dirname(here), 'apps', 'ui', 'src', 'main.js');
let t = fs.readFileSync(f, 'utf8');
const log = (m) => console.log(m);

// ① let → var（提升，消除 TDZ）
if (t.includes('let hotkeyUnsub = null;')) {
  t = t.replace('let hotkeyUnsub = null;', 'var hotkeyUnsub = null;');
  log('ok: hotkeyUnsub 改为 var');
} else {
  log('!! 未匹配 hotkeyUnsub');
}

// ② 从舞台初始化块里移除这两句
const from = `  setupMediaSession();
  bindHotkeyActions();
  void applyGlobalHotkeys();`;
if (t.includes(from)) {
  t = t.replace(from, '  setupMediaSession();');
  log('ok: 已从舞台初始化块移出');
} else {
  log('!! 未匹配舞台块内的三句');
}

// ③ 挪到模块末尾：那时所有函数与变量都已就绪
const tail = `

/* ------------------------------------------------------------------ */
/* 启动收尾：全局热键                                                   */
/* ------------------------------------------------------------------ */

/*
 * 放在模块**最末尾**调用，而不是塞进舞台初始化那块。
 *
 * 踩过的坑：原来写在舞台初始化里，而 bindHotkeyActions 内部引用的
 * hotkeyUnsub 是用 let 声明在后面的 —— 暂时性死区直接抛错，
 * 后面那句 applyGlobalHotkeys 就永远不执行，而且写在 void 里连报错都没有，
 * 表现是"热键完全没注册"，查起来毫无线索。
 *
 * 现在放在这里：所有声明都已完成，不存在顺序问题；
 * 而且显式 catch，真出问题会打在日志里。
 */
try {
  bindHotkeyActions();
  void applyGlobalHotkeys();
} catch (err) {
  console.error('[热键] 启动注册失败:', (err && err.message) || err);
}
`;
if (!t.includes('启动收尾：全局热键')) {
  t = t + tail;
  log('ok: 已追加到模块末尾');
} else {
  log('末尾块已存在');
}

fs.writeFileSync(f, t);
console.log('done');
