#!/usr/bin/env node
/**
 * 拉取参考源码到 reference/ 目录（不参与构建，仅用于移植时对照）
 *
 * 本机 git 的 HTTPS 走 schannel，是坏的；codeload 走 Node 的 https 正常。
 * 用 tarball 代替 git clone。
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'reference');
fs.mkdirSync(OUT, { recursive: true });

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

async function download(url, dest) {
  const name = path.basename(dest);
  for (let i = 1; i <= 4; i++) {
    let have = 0;
    try { have = fs.statSync(dest).size; } catch { have = 0; }
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (have > 0) headers.Range = `bytes=${have}-`;
    try {
      const { status, stream } = await request(url, { headers });
      if (status !== 200 && status !== 206) throw new Error(`HTTP ${status}`);
      const out = fs.createWriteStream(dest, { flags: have > 0 && status === 206 ? 'a' : 'w' });
      await new Promise((res, rej) => {
        stream.on('error', rej); out.on('error', rej); out.on('finish', res);
        stream.pipe(out);
      });
      const size = fs.statSync(dest).size;
      console.log(`[完成] ${name}  ${(size / 1e6).toFixed(1)} MB`);
      return dest;
    } catch (e) {
      console.log(`[失败 ${i}/4] ${name}: ${e.message}`);
      if (i < 4) await sleep(1500 * i);
    }
  }
  throw new Error(`${name} 下载失败`);
}

const TARGETS = [
  ['KuGouMusicApi', 'https://codeload.github.com/MakcRe/KuGouMusicApi/tar.gz/refs/heads/main'],
  ['Mineradio', 'https://codeload.github.com/XxHuberrr/Mineradio/tar.gz/refs/heads/main'],
];

for (const [repo, url] of TARGETS) {
  const dest = path.join(OUT, `${repo}.tar.gz`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) {
    console.log(`[已有] ${repo}.tar.gz`);
    continue;
  }
  console.log(`[下载] ${repo} ...`);
  await download(url, dest);
}

console.log('\n=== 参考源码就绪 ===');
for (const f of fs.readdirSync(OUT)) {
  console.log(`  ${f}  ${(fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(1)} MB`);
}
