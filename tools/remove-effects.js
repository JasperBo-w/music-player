'use strict';

/**
 * 从 effects.js 里精确删除指定的效果构建函数。
 *
 * 为什么用脚本而不是手工改：这些函数每个几十上百行，用字符串替换要整段贴进去，
 * 既容易贴错也看不清删了什么。按"函数起始行 → 该函数结尾的顶格 }"来删更可靠，
 * 而且删完会报出每个函数占了多少行，便于核对。
 *
 * 用法：node tools/remove-effects.js
 */

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'apps', 'ui', 'src', 'effects.js');

/** 要删掉的顶层函数名 */
const REMOVE_FUNCS = [
  'buildNebula',
  'buildGalaxy',
  'buildWarp',
  'buildWave',
  'buildSphere',
  'buildTerrain',
];

/** 要删掉的顶层常量 */
const REMOVE_CONSTS = ['TERRAIN_NOISE'];

let lines = fs.readFileSync(FILE, 'utf8').split('\n');

/** 找到某个顶层声明的起始行下标（0 基） */
function findStart(re, name) {
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  throw new Error(`找不到 ${name}`);
}

/** 从起始行往下找到该块结尾的顶格 '}'（0 基下标） */
function findEnd(startIdx) {
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === '}') return i;
  }
  throw new Error('找不到块结尾');
}

/** 收集待删区间 */
const ranges = [];

for (const fn of REMOVE_FUNCS) {
  const start = findStart(new RegExp(`^function ${fn}\\(`), fn);
  // 连带把函数上方的文档注释一起删掉
  let docStart = start;
  while (docStart > 0 && /^\s*(\*|\/\*\*)/.test(lines[docStart - 1])) docStart--;
  const end = findEnd(start);
  // 连带删掉后面紧跟的空行
  let trimEnd = end;
  while (trimEnd + 1 < lines.length && lines[trimEnd + 1].trim() === '') trimEnd++;
  ranges.push({ name: fn, from: docStart, to: trimEnd });
}

for (const cn of REMOVE_CONSTS) {
  const start = findStart(new RegExp(`^const ${cn} = `), cn);
  const end = start + (lines[start].trim().endsWith('`') ? 0 : findEnd(start) - start);
  // const XXX = ` ... `;  形态：找到以 `;` 结尾的那一行
  let realEnd = start;
  for (let i = start; i < lines.length; i++) {
    if (/`;\s*$/.test(lines[i])) {
      realEnd = i;
      break;
    }
  }
  let trimEnd = realEnd;
  while (trimEnd + 1 < lines.length && lines[trimEnd + 1].trim() === '') trimEnd++;
  ranges.push({ name: cn, from: start, to: trimEnd });
}

// 从后往前删，避免下标错位
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
