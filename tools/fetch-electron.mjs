#!/usr/bin/env node
/**
 * 手动安装 Electron 二进制
 *
 * 背景：npm install 时因为沙箱禁止管道 spawn，postinstall 生命周期脚本跑不了，
 * 所以用了 --ignore-scripts。代价是 electron 包只有 JS 外壳，没有真正的运行时，
 * 需要自己把二进制下下来放到 node_modules/electron/dist/ 并写 path.txt
 * ——这正是 electron 包 postinstall 干的活。
 *
 * 走 npmmirror 镜像，不依赖 GitHub Releases。
 *
 * 用法：node tools/fetch-electron.mjs [apps/desktop]
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_DIR = path.resolve(ROOT, process.argv[2] || 'apps/desktop');
const ELECTRON_DIR = path.join(APP_DIR, 'node_modules', 'electron');

if (!fs.existsSync(path.join(ELECTRON_DIR, 'package.json'))) {
  console.error(`找不到 electron 包: ${ELECTRON_DIR}`);
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8')).version;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const zipName = `electron-v${version}-win32-${arch}.zip`;
const distDir = path.join(ELECTRON_DIR, 'dist');

console.log(`Electron 版本: ${version}  (win32-${arch})`);

if (fs.existsSync(path.join(distDir, 'electron.exe'))) {
  console.log(`已安装: ${path.join(distDir, 'electron.exe')}`);
  process.exit(0);
}

const MIRRORS = [
  `https://npmmirror.com/mirrors/electron/${version}/${zipName}`,
  `https://registry.npmmirror.com/-/binary/electron/${version}/${zipName}`,
  `https://github.com/electron/electron/releases/download/v${version}/${zipName}`,
];

const DL_DIR = path.join(ROOT, '.toolchain', 'dl');
fs.mkdirSync(DL_DIR, { recursive: true });
const zipPath = path.join(DL_DIR, zipName);

const AGENT = new https.Agent({ keepAlive: true });

function request(url, { method = 'GET', headers = {}, redirects = 8 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, agent: AGENT, timeout: 60000 }, (res) => {
      const { statusCode, headers: h } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && h.location && redirects > 0) {
        res.resume();
        resolve(request(new URL(h.location, url).toString(), { method, headers, redirects: redirects - 1 }));
        return;
      }
      resolve({ status: statusCode, headers: h, stream: res });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const human = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB');

async function download(url, dest) {
  let have = 0;
  try { have = fs.statSync(dest).size; } catch { have = 0; }
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  if (have > 0) headers.Range = `bytes=${have}-`;

  const { status, headers: h, stream } = await request(url, { headers });
  if (status !== 200 && status !== 206) { stream.resume(); throw new Error(`HTTP ${status}`); }
  if (have > 0 && status === 200) have = 0;

  const total = (() => {
    const cl = parseInt(h['content-length'] || '0', 10);
    if (status === 206 && h['content-range']) {
      const m = /\/(\d+)\s*$/.exec(h['content-range']);
      if (m) return parseInt(m[1], 10);
    }
    return have + cl;
  })();

  const out = fs.createWriteStream(dest, { flags: have > 0 && status === 206 ? 'a' : 'w' });
  let got = have;
  let tick = Date.now();
  await new Promise((res, rej) => {
    stream.on('data', (c) => {
      got += c.length;
      if (Date.now() - tick > 1500) {
        tick = Date.now();
        process.stdout.write(`\r         ${total ? ((got / total) * 100).toFixed(1) + '%' : ''}  ${human(got)}/${human(total)}      `);
      }
    });
    stream.on('error', rej);
    out.on('error', rej);
    out.on('finish', res);
    stream.pipe(out);
  });
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  const size = fs.statSync(dest).size;
  if (total && size !== total) throw new Error(`不完整 ${human(size)}/${human(total)}`);
  return size;
}

async function main() {
  for (const url of MIRRORS) {
    for (let i = 1; i <= 3; i++) {
      try {
        console.log(`[尝试 ${i}/3] ${new URL(url).host}`);
        const size = await download(url, zipPath);
        console.log(`[完成] ${zipName}  ${human(size)}`);
        break;
      } catch (e) {
        console.log(`[失败] ${e.message}`);
        if (i < 3) await sleep(1500 * i);
        if (i === 3) throw new Error('该镜像不可用');
      }
    }
    break;
  }

  // 解压（tar.exe 能处理 zip），这一步交给 PowerShell 调用方更稳，
  // 这里直接用 tar 通过 stdio:inherit 的方式不可用，所以输出指令
  console.log(`\n压缩包已就绪: ${zipPath}`);
  console.log(`接下来解压到: ${distDir}`);
  fs.writeFileSync(path.join(ROOT, '.toolchain', 'electron-zip-path.txt'), zipPath, 'utf8');
}

main().catch((e) => {
  console.error('\n[失败] ' + e.message);
  process.exit(1);
});
