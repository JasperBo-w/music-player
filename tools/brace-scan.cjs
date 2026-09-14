/*
 * 花括号深度扫描器。
 *
 * 为什么需要：main.js 被我两次失败的"按行号搬块"搞坏了，整体配平但层级错乱，
 * node --check 只报一个症状点（"Unexpected token"），不报根因在哪。
 * 靠推理已经出现矛盾（补一个 } 错误位置就跑到别处），所以要拿真实数据。
 *
 * 必须跳过：行注释、块注释、单/双引号字符串、模板字符串（含 ${} 嵌套）。
 * 这个文件里有大量含花括号的模板字符串，不跳过的话计数全是噪声 ——
 * 我前面那次"depth=5"就是被它污染的。
 */
const fs = require('node:fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

let i = 0;
let line = 1;
let depth = 0;
const marks = []; // 每行结束时的深度
let state = 'code'; // code | line | block | sq | dq | tpl
const tplStack = []; // 模板串里 ${ 的嵌套深度

while (i < src.length) {
  const ch = src[i];
  const next = src[i + 1];
  if (ch === '\n') {
    marks[line] = depth;
    line++;
    if (state === 'line') state = 'code';
    i++;
    continue;
  }
  if (state === 'code') {
    if (ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
    if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
    if (ch === "'") { state = 'sq'; i++; continue; }
    if (ch === '"') { state = 'dq'; i++; continue; }
    if (ch === '`') { state = 'tpl'; i++; continue; }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') {
      depth--;
      // 回到进入 ${ 时的深度 = 这个 } 就是与它配对的，出栈并回到模板串状态
      if (tplStack.length && depth === tplStack[tplStack.length - 1]) {
        tplStack.pop();
        state = 'tpl';
      }
      i++;
      continue;
    }
    i++;
    continue;
  }
  if (state === 'line') { i++; continue; }
  if (state === 'block') {
    if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
    i++;
    continue;
  }
  if (state === 'sq' || state === 'dq') {
    if (ch === '\\') { i += 2; continue; }
    if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"')) state = 'code';
    i++;
    continue;
  }
  if (state === 'tpl') {
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') { state = tplStack.length ? 'code' : 'code'; i++; continue; }
    if (ch === '$' && next === '{') {
      // 模板串里的表达式：花括号要计数，但要记住进来时的深度，
      // 好知道哪个 } 才是与它配对的那一个（否则永远不出栈，深度固定虚高）
      tplStack.push(depth);
      depth++;
      state = 'code';
      i += 2;
      continue;
    }
    i++;
    continue;
  }
}

console.log('扫描结束，最终 depth =', depth, '（0 才是配平）');
const from = Number(process.argv[3] || 1);
const to = Number(process.argv[4] || line);
console.log(`--- 每行结束时的深度（${from}..${to}）---`);
for (let n = from; n <= to && n < marks.length; n++) {
  if (marks[n] === undefined) continue;
  console.log(`  ${n}: depth=${marks[n]}`);
}
