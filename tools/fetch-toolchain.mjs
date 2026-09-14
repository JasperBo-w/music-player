#!/usr/bin/env node
/**
 * Android 工具链下载器
 *
 * 本机的 git / curl 的 HTTPS 通道是坏的（schannel: SEC_E_NO_CREDENTIALS），
 * 但 Node 自带的 OpenSSL 通道完好 —— 所以统一用 Node 下载。
 *
 * 每个组件配多个镜像候选（优先国内镜像，快且稳），失败自动切换；
 * 单个文件支持 HTTP Range 断点续传 + 指数退避重试。
 *
 * 产物落在 .toolchain/dl/，解压见 tools/extract-toolchain.ps1
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

// 注意: 不能用 new URL(import.meta.url).pathname —— 中文目录会被百分号编码
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DL = path.join(ROOT, '.toolchain', 'dl');
fs.mkdirSync(DL, { recursive: true });

const AGENT = new https.Agent({ keepAlive: true, maxSockets: 4 });

/** 发起请求，自动跟随重定向。返回 { status, headers, stream } */
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

function human(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}

/** 下载一次（含续传）。返回本地文件大小 */
async function attempt(url, dest) {
  let have = 0;
  try { have = fs.statSync(dest).size; } catch { have = 0; }

  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
  if (have > 0) headers.Range = `bytes=${have}-`;

  const { status, headers: h, stream } = await request(url, { headers });

  if (have > 0 && status === 200) {
    have = 0; // 服务器不支持 Range，从头来过
  } else if (have > 0 && status !== 206) {
    throw new Error(`续传请求返回 HTTP ${status}`);
  }
  if (status !== 200 && status !== 206) {
    stream.resume();
    throw new Error(`HTTP ${status}`);
  }

  let total = 0;
  if (status === 206 && h['content-range']) {
    const m = /\/(\d+)\s*$/.exec(h['content-range']);
    if (m) total = parseInt(m[1], 10);
  }
  if (!total) total = have + parseInt(h['content-length'] || '0', 10);

  const out = fs.createWriteStream(dest, { flags: have > 0 ? 'a' : 'w' });
  let got = have;
  let lastTick = Date.now();

  await new Promise((resolve, reject) => {
    stream.on('data', (c) => {
      got += c.length;
      const now = Date.now();
      if (now - lastTick > 1500) {
        lastTick = now;
        const pct = total ? ((got / total) * 100).toFixed(1) + '%' : '?';
        process.stdout.write(`\r         ${pct}  ${human(got)} / ${human(total)}        `);
      }
    });
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    stream.pipe(out);
  });

  process.stdout.write('\r' + ' '.repeat(72) + '\r');

  const size = fs.statSync(dest).size;
  if (total && size !== total) throw new Error(`不完整: ${human(size)} / ${human(total)}`);
  return size;
}

/** 多候选 + 重试下载 */
async function fetchComponent({ label, candidates }) {
  console.log(`\n=== ${label} ===`);
  for (const { url, name } of candidates) {
    const dest = path.join(DL, name);
    if (fs.existsSync(dest)) {
      console.log(`[已有] ${name}  ${human(fs.statSync(dest).size)}`);
      return dest;
    }
    for (let i = 1; i <= 4; i++) {
      try {
        console.log(`[尝试 ${i}/4] ${new URL(url).host}  ${name}`);
        const size = await attempt(url, dest);
        console.log(`[完成] ${name}  ${human(size)}`);
        return dest;
      } catch (e) {
        console.log(`[失败] ${e.message}`);
        if (i < 4) await sleep(2000 * i);
      }
    }
    console.log(`[放弃] 该镜像不可用，切换下一个候选`);
  }
  throw new Error(`${label} 的所有镜像均失败`);
}

const COMPONENTS = [
  {
    label: 'Eclipse Temurin JDK 17 (Windows x64)',
    candidates: [
      { url: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip',
        name: 'OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip' },
      { url: 'https://download.visualstudio.microsoft.com/download/pr/26480204-af7a-4cfe-b22e-d123159ca2c7/8e14867d6280442d69ab9adc7fdc23ef/microsoft-jdk-17.0.13-windows-x64.zip',
        name: 'microsoft-jdk-17.0.13-windows-x64.zip' },
      { url: 'https://mirrors.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip',
        name: 'openjdk-17.0.2_windows-x64_bin.zip' },
    ],
  },
  {
    label: 'Android SDK command-line tools',
    candidates: [
      { url: 'https://mirrors.cloud.tencent.com/AndroidSDK/commandlinetools-win-11076708_latest.zip',
        name: 'commandlinetools-win-11076708_latest.zip' },
      { url: 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip',
        name: 'commandlinetools-win-11076708_latest.zip' },
    ],
  },
  {
    label: 'Gradle 8.11.1',
    candidates: [
      { url: 'https://mirrors.cloud.tencent.com/gradle/gradle-8.11.1-bin.zip',
        name: 'gradle-8.11.1-bin.zip' },
      { url: 'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip',
        name: 'gradle-8.11.1-bin.zip' },
    ],
  },
];

async function main() {
  for (const c of COMPONENTS) await fetchComponent(c);
  console.log('\n=== 全部就绪 ===');
  for (const f of fs.readdirSync(DL)) {
    console.log(`  ${f}  ${human(fs.statSync(path.join(DL, f)).size)}`);
  }
}

main().catch((e) => {
  console.error('\n[整体失败] ' + e.message);
  process.exit(1);
});
