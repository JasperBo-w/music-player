/*
 * 二分定位卡顿。
 *
 * 一次跑完所有配置，每档之间**清空采样再量**，最后打一张对照表。
 * 为什么要写成脚本而不是一条条手发：每档要"重置 → 静置 13 秒 → 读数"，
 * 七档就是二十多次往返，手发既慢又容易漏掉重置那一步 ——
 * 而漏掉重置会让上一档的样本混进来，差异全是噪声。
 *
 * 关掉某一层时**必须回读实际生效的值**，不能只看"我以为设了"。
 * 之前在这个坑里栽过好几次：日志说关掉了，画面根本没变。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(path.dirname(here), '.repl');
const cmdFile = path.join(dir, 'cmd.json');
const outFile = path.join(dir, 'out.jsonl');

fs.mkdirSync(dir, { recursive: true });

let seq = 0;
try {
  const prev = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
  if (prev && typeof prev.seq === 'number') seq = prev.seq;
} catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(js, timeout = 30000) {
  seq += 1;
  const mine = seq;
  let from = 0;
  try {
    from = fs.statSync(outFile).size;
  } catch {}
  fs.writeFileSync(cmdFile, JSON.stringify({ seq: mine, js }));
  const t0 = Date.now();
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
      if (rec.seq === mine && (rec.error !== undefined || rec.result !== undefined)) {
        if (rec.error) throw new Error(rec.error);
        return rec.result;
      }
    }
    if (Date.now() - t0 > timeout) throw new Error(`seq=${mine} 超时`);
    await sleep(120);
  }
}

const SETTLE_MS = 13000;

/*
 * 逐项累加地关（① 全开 → ⑥ 全关）。
 *
 * 每一档的 setup **自己返回"实际生效的证据"**，而不是事后再去读 ——
 * 我第一版写的读回是调用 __mpLayers({particles:true, cover:true})，
 * 那是一句**写**操作，会把刚关掉的层又打开，然后我拿着"已恢复"的状态
 * 去量这一档的性能。差点又是一次"验证了个寂寞"。
 */
const configs = [
  {
    name: '① 全开（基线）',
    setup: "'基线'",
  },
  {
    name: '② +关磨砂',
    setup:
      "document.documentElement.classList.add('no-glass-blur');" +
      "'glassOff=' + document.documentElement.classList.contains('no-glass-blur')",
  },
  {
    name: '③ +关泛光',
    setup: "window.__mpSet({bloom:false}); 'bloomOff'",
  },
  {
    name: '④ +关封面层',
    setup:
      "window.__mpLayers({particles:true,cover:false}).then(r=>JSON.stringify(r.actual)+' ok='+r.ok)",
  },
  {
    name: '⑤ +关背景粒子',
    setup:
      "window.__mpLayers({particles:false,cover:false}).then(r=>JSON.stringify(r.actual)+' ok='+r.ok)",
  },
  {
    name: '⑥ +关专辑氛围背景',
    setup: "window.__mpBgOff() + ' 层已隐藏'",
  },
];

const out = [];
/*
 * ★ 先"带缓存绕过地重新拉一遍模块"，再 reload。
 *
 * 踩过的坑：直接 location.reload() **拿不到新代码** —— app:// 的响应被
 * Chromium 缓存了，reload 之后 window.__mpJank 依然是 undefined（文件里明明有）。
 * 我当时差点以为是自己的代码写错了。用 fetch(..., {cache:'reload'})
 * 逐个把模块重新拉一遍（这个模式会绕过缓存并刷新缓存条目），再 reload 才有用。
 */
const MODULES = [
  '/src/main.js',
  '/src/particles.js',
  '/src/effects.js',
  '/src/settings.js',
  '/src/settings-panel.js',
  '/src/lyrics.js',
  '/src/api.js',
  '/src/bloom.js',
  '/index.html',
  '/src/styles.css',
];
const busted = await send(
  `(async () => {
     const files = ${JSON.stringify(MODULES)};
     const out = [];
     for (const f of files) {
       try { const t = await (await fetch(f, { cache: 'reload' })).text(); out.push(f + '=' + t.length); }
       catch (e) { out.push(f + '=ERR'); }
     }
     location.reload();
     return out.join(' ');
   })()`,
  40000
);
console.log('[二分] 已绕过缓存重拉模块:', busted);

/*
 * 再等页面把探测钩子挂上。
 * 刚 reload 完就发命令，$ 可能还没定义 —— 直接 send 会抛
 * "Script failed to execute"，看着像功能坏了，其实只是没等够。
 */
for (let i = 0; i < 60; i++) {
  const ready = await send(
    "typeof window.__mpShowCover === 'function' && typeof window.__mpJank === 'function'"
  ).catch(() => false);
  if (ready === true) break;
  await sleep(700);
}
console.log('[二分] 起播…');
await send('window.__mpShowCover && window.__mpShowCover()', 60000);
await sleep(8000);

for (const c of configs) {
  const proof = await send(c.setup);
  await sleep(1200);
  await send('window.__mpJank(true)');
  await sleep(SETTLE_MS);
  const j = await send('window.__mpJank()');
  out.push({ name: c.name, proof, ...(j || {}) });
  console.log(
    `${c.name.padEnd(18)} fps=${String(j && j.fps).padStart(3)}  p50=${String(j && j.p50).padStart(5)}  ` +
      `p95=${String(j && j.p95).padStart(5)}  p99=${String(j && j.p99).padStart(6)}  ` +
      `最长=${String(j && j.max).padStart(6)}  超33ms=${String(j && j.over33).padStart(3)}  超50ms=${String(j && j.over50).padStart(3)}  | ${proof}`
  );
}

console.log('\n===== JSON =====');
console.log(JSON.stringify(out, null, 2));
