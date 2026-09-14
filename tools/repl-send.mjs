/*
 * 给常驻 Electron 调试进程发一条命令，并等它的结果。
 *
 * 用法：
 *   node tools/repl-send.mjs "<要执行的 JS>" [截图输出路径] [超时毫秒]
 *   node tools/repl-send.mjs @脚本路径 [截图输出路径] [超时毫秒]
 *
 * ★ 为什么要有 @文件 模式：
 *   Windows 传 argv 时会**吃掉双引号** —— 命令行写 JSON.stringify("a")，
 *   到了渲染进程变成 JSON.stringify(a)，直接报语法错。中文也会被搞坏。
 *   所以凡是要用引号、中文、或含 / 的正则，一律写进 .js 文件再 @ 过来。
 *   这个坑我踩了至少五次（查 localStorage、调 playlistCreate……），
 *   每次都被误判成"IPC 没接上"，查半天。
 *
 * 特意**不启动任何子进程**：这台机器的沙箱禁止命名管道，
 * 用 child_process 抓子进程输出会 EPERM。这里只做纯文件读写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(path.dirname(here), '.repl');
const cmdFile = path.join(dir, 'cmd.json');
const outFile = path.join(dir, 'out.jsonl');

let js = process.argv[2];
const shot = process.argv[3] || undefined;
const timeout = Number(process.argv[4] || 45000);

if (js && js.startsWith('@')) {
  const p = path.resolve(path.dirname(here), js.slice(1));
  js = fs.readFileSync(p, 'utf8');
  /*
   * ★ 去掉 UTF-8 BOM。
   *
   * PowerShell 的 `Set-Content -Encoding UTF8` 会**带 BOM 写**，
   * 而 BOM 注入页面后就变成"第一个 token 是 \uFEFF" ——
   * 渲染进程直接抛 `Uncaught SyntaxError: Invalid or unexpected token`，
   * 而且报错位置指向 **index.html 的某一行**（注入脚本在文档里的偏移），
   * 看起来像"应用自己的 HTML 坏了"，很难往这上面想。
   *
   * 我今晚在这上面栽了好几次，还一度误判成"某个特殊字符（→）损坏"。
   * 在这里统一剥掉，比每次写文件时记得用无 BOM 编码靠谱。
   */
  if (js.charCodeAt(0) === 0xfeff) js = js.slice(1);
}

if (!js) {
  console.error('用法: node tools/repl-send.mjs "<JS>"|@脚本路径 [截图路径] [超时ms]');
  process.exit(2);
}

fs.mkdirSync(dir, { recursive: true });

// seq 从已有的 cmd.json 上加一，保证"每次都是新命令"
let seq = 1;
try {
  const prev = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
  if (prev && typeof prev.seq === 'number') seq = prev.seq + 1;
} catch {}

// 记下发送前的文件长度，只从这之后找结果
let from = 0;
try {
  from = fs.statSync(outFile).size;
} catch {}

fs.writeFileSync(cmdFile, JSON.stringify({ seq, js, shot }));

const t0 = Date.now();
const poll = () => {
  let text = '';
  try {
    const buf = fs.readFileSync(outFile);
    text = buf.subarray(from).toString('utf8');
  } catch {}

  const lines = text.split('\n').filter(Boolean);
  let got = null;
  let shotDone = false;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.seq !== seq) continue;
    if (rec.shot || rec.shotError) shotDone = true;
    if (rec.error !== undefined || rec.result !== undefined) got = rec;
    if (rec.shotError) {
      console.log(JSON.stringify({ seq, error: rec.shotError }));
      process.exit(1);
    }
  }

  if (got && (!shot || shotDone)) {
    console.log(JSON.stringify(got, null, 2));
    process.exit(got.error ? 1 : 0);
  }
  if (Date.now() - t0 > timeout) {
    console.error(`[超时 ${timeout}ms] 没等到 seq=${seq} 的结果。REPL 进程还在吗？`);
    process.exit(3);
  }
  setTimeout(poll, 150);
};

setTimeout(poll, 150);
