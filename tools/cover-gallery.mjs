/*
 * 封面画廊：连续切歌，每首只留封面层截一张图。
 *
 * 起因：我一直只在一张专辑上判断封面渲染的好坏，而那张恰好是黑底低对比的
 * 碎拼贴 —— 拿最难的一张去下结论，等于不知道这套渲染"正常起来"是什么样。
 * 所以先横着看几张不同的封面，再决定改什么。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const dir = path.join(root, '.repl');
const cmdFile = path.join(dir, 'cmd.json');
const outFile = path.join(dir, 'out.jsonl');
const shotDir = path.join(root, '.shots-cover');
fs.mkdirSync(shotDir, { recursive: true });

const N = Number(process.argv[2] || 5);

let seq = 0;
try {
  const prev = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
  if (prev && typeof prev.seq === 'number') seq = prev.seq;
} catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(js, shot, timeout = 90000) {
  seq += 1;
  const mine = seq;
  let from = 0;
  try {
    from = fs.statSync(outFile).size;
  } catch {}
  fs.writeFileSync(cmdFile, JSON.stringify({ seq: mine, js, shot }));
  const t0 = Date.now();
  let result = null;
  let gotResult = false;
  let gotShot = !shot;
  for (;;) {
    let text = '';
    try {
      text = fs.readFileSync(outFile).subarray(from).toString('utf8');
    } catch {}
    for (const line of text.split('\n').filter(Boolean)) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.seq !== mine) continue;
      if (rec.error) throw new Error(rec.error);
      if (rec.result !== undefined) {
        result = rec.result;
        gotResult = true;
      }
      if (rec.shotError) throw new Error('截图失败: ' + rec.shotError);
      if (rec.shot) gotShot = true;
    }
    if (gotResult && gotShot) return result;
    if (Date.now() - t0 > timeout) throw new Error(`seq=${mine} 超时`);
    await sleep(120);
  }
}

// 等钩子挂上
for (let i = 0; i < 60; i++) {
  const ok = await send(
    "typeof window.__mpShowCover === 'function' && typeof window.__mpLayers === 'function'"
  ).catch(() => false);
  if (ok === true) break;
  await sleep(700);
}

const rows = [];
for (let i = 0; i < N; i++) {
  if (i === 0) {
    await send('window.__mpShowCover && window.__mpShowCover()');
  } else {
    await send("document.querySelector('#pb-next').click(); 'next'");
  }
  // 等歌加载 + 封面下载 + 重采样
  await sleep(7000);

  const info = await send(
    "JSON.stringify({歌:document.querySelector('#pb-title')?.textContent, 手:document.querySelector('#pb-artist')?.textContent, 封面:!!document.querySelector('#np-cover'), 粒子:window.__mpJank()['粒子层'], 封面层:window.__mpJank()['封面层']})"
  );
  // 只留封面层
  await send('window.__mpLayers({particles:false,cover:true})');
  // 成形动画走完
  await sleep(2500);
  const file = path.join(shotDir, `${i + 1}.png`);
  await send('1', file);
  rows.push({ i: i + 1, info, file });
  console.log(`[${i + 1}/${N}] ${info}  → ${path.basename(file)}`);
}

// 还原成两层都显示
await send('window.__mpLayers({particles:true,cover:true})');
console.log('\n完成。图在 ' + shotDir);
