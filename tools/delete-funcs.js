'use strict';

/**
 * 删除指定的顶层函数 / 顶层常量（按"起始行 → 顶格 }"精确切除）。
 *
 * 用法：node tools/delete-funcs.js buildRipple buildAurora buildGravity
 */

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'apps', 'ui', 'src', 'effects.js');
const names = process.argv.slice(2);
if (!names.length) {
  console.error('用法: node tools/delete-funcs.js <函数名或常量名> ...');
  process.exit(1);
}

const lines = fs.readFileSync(FILE, 'utf8').split('\n');
const ranges = [];

for (const name of names) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (
      new RegExp(`^function ${name}\\(`).test(lines[i]) ||
      new RegExp(`^const ${name} = `).test(lines[i])
    ) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    console.error(`找不到 ${name}`);
    process.exit(1);
  }

  // 连带删掉上方紧邻的文档注释
  let docStart = start;
  while (docStart > 0 && /^\s*(\*|\/\*\*)/.test(lines[docStart - 1])) docStart--;

  // 找结尾：顶格的 '}' 或模板字符串的 `;
  let end = start;
  if (/^const /.test(lines[start])) {
    for (let i = start; i < lines.length; i++) {
      if (/`;\s*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
  } else {
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i] === '}') {
        end = i;
        break;
      }
    }
  }
  while (end + 1 < lines.length && lines[end + 1].trim() === '') end++;

  ranges.push({ name, from: docStart, to: end });
}

ranges.sort((a, b) => b.from - a.from);
console.log('将要删除：');
for (const r of ranges) {
  console.log(`  ${r.name.padEnd(16)} 第 ${r.from + 1}~${r.to + 1} 行（${r.to - r.from + 1} 行）`);
}

let removed = 0;
for (const r of ranges) {
  lines.splice(r.from, r.to - r.from + 1);
  removed += r.to - r.from + 1;
}

fs.writeFileSync(FILE, lines.join('\n'));
console.log(`\n共删除 ${removed} 行，剩余 ${lines.length} 行`);
