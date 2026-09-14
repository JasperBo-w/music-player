/*
 * 效果画廊：逐个切换粒子效果，各截一张（只留该效果自己）。
 *
 * 为什么需要：除了「封面粒子」，其余 6 个效果我从来没有单独看过 ——
 * 一直是在合成图里扫一眼。合成图里背景效果被封面、文字、UI 压着，
 * 根本判断不出它本身好不好。这和"只拿一张专辑判断封面渲染"是同一个毛病。
 *
 * 现在封面层已经被门控在自己的效果里，所以切到别的效果时画面上
 * 天然只剩该效果自己，不需要额外隐藏什么。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const dir = path.join(root, '.repl');
const cmdFile = path.join(dir, 'cmd.json');
const outFile = path.join(dir, 'out.jsonl');
const shotDir = path.join(root, '.shots-effects');
fs.mkdirSync(shotDir, { recursive: true });

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

for (let i = 0; i < 60; i++) {
  const ok = await send(
    "typeof window.__mpSet === 'function' && typeof window.__mpJank === 'function'"
  ).catch(() => false);
  if (ok === true) break;
  await sleep(700);
}

// 起播：没有音乐，所有效果都是静态的，看不出好坏
await send('window.__mpShowCover && window.__mpShowCover()');
await sleep(9000);

const list = await send('JSON.stringify(window.__mpEffectList ? window.__mpEffectList() : null)');
console.log('效果列表:', list);

const KEYS = ['spectrum', 'spectrogram', 'coral', 'tunnel', 'rain', 'vinyl', 'halo'];
const rows = [];
for (const k of KEYS) {
  await send(`window.__mpSet({effect:'${k}'})`);
  // 等着色器编译 + 成形动画走完（第一次编译会有明显停顿）
  await sleep(4000);
  const info = await send(
    `(function(){var j=window.__mpJank();return JSON.stringify({effect:(document.querySelector('#pb-title')||{}).textContent, scale:j.scale, fps:j.fps, cover:j['封面层']});})()`
  );
  const file = path.join(shotDir, `${k}.png`);
  await send('1', file);
  rows.push({ k, info });
  console.log(`[${k}] ${info}  → ${path.basename(file)}`);
}

// 还原成默认效果
await send("window.__mpSet({effect:'cover'})");
console.log('\n完成。图在 ' + shotDir);
