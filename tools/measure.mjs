/*
 * 通用性能测量器。
 *
 * 用法：
 *   node tools/measure.mjs --file <配置.json>
 *   也支持直接传 JSON 字符串，但**经 PowerShell 传参时引号会被吃掉**，所以优先用 --file。
 * JSON: { "rounds": 2, "settleMs": 20000, "reload": false,
 *         "configs": [ { "name": "...", "setup": "<JS，返回一段证明>" } ] }
 *
 * 为什么要有这个工具：
 * 帧间隔是**噪声很大**的量 —— 长帧是稀有事件，13 秒里可能只出现 2 次还是 19 次，
 * 全看运气。只跑一遍就下结论，等于把噪声当信号。
 * 所以这里支持**多轮**：把几档配置交替跑好几遍（A/B/A/B 而不是 A/A/B/B），
 * 这样"漂移"会被分摊到每一档上，而不是错记到某一档头上。
 *
 * 另外每一档都要求 setup **自己返回实际生效的证据**，不接受"我以为设了"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(path.dirname(here), '.repl');
const cmdFile = path.join(dir, 'cmd.json');
const outFile = path.join(dir, 'out.jsonl');

fs.mkdirSync(dir, { recursive: true });

const args = process.argv.slice(2);
let specRaw;
if (args[0] === '--file') {
  // 去掉可能的 BOM（PowerShell 的 Out-File -Encoding utf8 会加一个）
  specRaw = fs.readFileSync(args[1], 'utf8').replace(/^\uFEFF/, '');
} else {
  specRaw = args[0] || '{}';
}
const spec = JSON.parse(specRaw);
const configs = spec.configs || [];
const rounds = spec.rounds || 1;
const settleMs = spec.settleMs || 20000;
if (!configs.length) {
  console.error('没有配置');
  process.exit(2);
}

let seq = 0;
try {
  const prev = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
  if (prev && typeof prev.seq === 'number') seq = prev.seq;
} catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(js, timeout = 60000) {
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

if (spec.reload) {
  const MODULES = [
    '/src/main.js',
    '/src/particles.js',
    '/src/effects.js',
    '/src/settings.js',
    '/src/settings-panel.js',
    '/src/lyrics.js',
    '/src/bloom.js',
    '/index.html',
    '/src/styles.css',
  ];
  // 必须绕过缓存重拉，否则 reload 拿到的是旧代码（踩过）
  await send(
    `(async () => {
       for (const f of ${JSON.stringify(MODULES)}) {
         try { await (await fetch(f, { cache: 'reload' })).text(); } catch (e) {}
       }
       // 有些开关只能在**建 context 之前**决定，必须靠 URL 传递并在 reload 时生效
       location.hash = ${JSON.stringify(spec.hash || '')};
       location.reload();
       return 'reloaded hash=' + location.hash;
     })()`,
    60000
  );
  for (let i = 0; i < 60; i++) {
    const ok = await send(
      "typeof window.__mpJank === 'function' && typeof window.__mpShowCover === 'function'"
    ).catch(() => false);
    if (ok === true) break;
    await sleep(700);
  }
}

// 确保有音乐在放：频谱/节拍是真实负载的一部分，不能省
await send('window.__mpShowCover && window.__mpShowCover()').catch(() => {});
await sleep(6000);
/*
 * ★ 必须确认渲染循环**真的在跑**再开始测量。
 *
 * 踩过的坑：有一轮 A 组测出来 p50=undefined、fps 正好 60 ——
 * 60 是构造函数里的默认值，说明 _trackPerf 一次都没执行过，
 * 也就是循环因为"没在播放"处于 paused，整个画面根本没出。
 * 我差点把这一组当成"desync 关闭时的基线"拿去对比。
 * 判据很简单：有样本（jank.n 有值）才说明真的在出图。
 */
let loopLive = false;
for (let i = 0; i < 20; i++) {
  const ok = await send(
    '(function(){var j=window.__mpJank&&window.__mpJank(); return !!(j && j.n > 3);})()'
  ).catch(() => false);
  if (ok === true) {
    loopLive = true;
    break;
  }
  await send('window.__mpShowCover && window.__mpShowCover()').catch(() => {});
  await sleep(1500);
}
if (!loopLive) {
  console.error('[中止] 渲染循环没在出图（多半是没有播放）—— 这一轮数据不可用，别拿来对比。');
  process.exit(4);
}
console.log('[测量] 渲染循环已确认在出图');
// 探测期间禁止写盘，绝不碰用户设置
await send("window.__mpProbeGuard && window.__mpProbeGuard(true)").catch(() => {});

/*
 * 两种度量：
 *   'jank'    —— 用宿主自己的帧间隔环形缓冲（p50/p95/p99 + 长帧计数）
 *   'cadence' —— 现场跑一个独立的裸 requestAnimationFrame 循环量帧间隔。
 *
 * 为什么要第二种：裸循环的**最小值**就是显示器的垂直同步间隔。
 * 有了它才能判断"到底是应用慢"还是"整台机器就这个节奏" ——
 * 实测把 WebGL 画布一隐藏，p50 立刻回到 6.1ms（165Hz），
 * 这一步才把问题锁死在 WebGL 层，前面用长帧计数怎么测都是噪声。
 */
const METRIC = spec.metric === 'cadence' ? 'cadence' : 'jank';
const CADENCE_N = spec.cadenceFrames || 500;

const RESET_EXPR = METRIC === 'cadence' ? "'noreset'" : 'window.__mpJank(true)';
const READ_EXPR =
  METRIC === 'cadence'
    ? `(async () => {
         const g = []; let last = performance.now(); let i = 0;
         await new Promise((done) => {
           const f = () => {
             const t = performance.now();
             g.push(t - last); last = t;
             if (++i < ${CADENCE_N}) requestAnimationFrame(f); else done();
           };
           requestAnimationFrame(f);
         });
         g.sort((a, b) => a - b);
         const q = (p) => +g[Math.min(g.length - 1, Math.floor(g.length * p))].toFixed(2);
         // 顺带把当前真实渲染配置带回来，否则拿着一堆数字不知道是什么配置跑的
         const c = window.__mpJank ? window.__mpJank() : {};
         return { metric: 'cadence', n: g.length, min: q(0), p5: q(0.05), p25: q(0.25),
                  p50: q(0.5), p75: q(0.75), p95: q(0.95), max: q(1),
                  fps: c.fps, jsMs: c.jsMs, scale: c.scale, bloom: c.bloom,
                  粒子层: c['粒子层'], 封面层: c['封面层'],
                  glassOff: document.documentElement.classList.contains('no-glass-blur') };
       })()`
    : 'window.__mpJank()';

const results = [];
for (let r = 0; r < rounds; r++) {
  for (const c of configs) {
    let proof;
    try {
      proof = await send(c.setup);
    } catch (e) {
      proof = 'SETUP失败: ' + e.message;
    }
    await sleep(1500);
    await send(RESET_EXPR);
    if (METRIC === 'jank') await sleep(settleMs);
    const j = (await send(READ_EXPR, 90000)) || {};
    const row = { round: r + 1, name: c.name, proof, ...j };
    results.push(row);
    if (METRIC === 'cadence') {
      console.log(
        `第${r + 1}轮 ${String(c.name).padEnd(22)} min=${String(j.min).padStart(5)}  p25=${String(j.p25).padStart(5)}  ` +
          `p50=${String(j.p50).padStart(5)}  p75=${String(j.p75).padStart(5)}  p95=${String(j.p95).padStart(5)}  ` +
          `max=${String(j.max).padStart(6)}  jsMs=${String(j.jsMs).padStart(5)}  | 泛光=${j.bloom} scale=${j.scale} desync=${j.desync} 粒子=${j['粒子层']} 封面=${j['封面层']} 磨砂关=${j.glassOff} | ${proof}`
      );
    } else {
      console.log(
        `第${r + 1}轮 ${String(c.name).padEnd(22)} fps=${String(j.fps).padStart(3)}  ` +
          `p50=${String(j.p50).padStart(5)}  p95=${String(j.p95).padStart(5)}  p99=${String(j.p99).padStart(6)}  ` +
          `最长=${String(j.max).padStart(6)}  超33=${String(j.over33).padStart(3)}  超50=${String(j.over50).padStart(3)}  n=${j.n}  ` +
          `| 泛光=${j.bloom} scale=${j.scale} desync=${j.desync} 粒子=${j.粒子层} 封面=${j.封面层} | ${proof}`
      );
    }
  }
}

// 汇总：同一档跨轮求平均，噪声才不会盖过差异
console.log('\n===== 汇总（跨轮平均）=====');
const byName = new Map();
for (const r of results) {
  if (!byName.has(r.name)) byName.set(r.name, []);
  byName.get(r.name).push(r);
}
const KEYS = METRIC === 'cadence'
  ? ['min', 'p25', 'p50', 'p75', 'p95', 'max']
  : ['fps', 'p50', 'p95', 'p99', 'max', 'over33', 'over50'];
for (const [name, rows] of byName) {
  const avg = (k) => (rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) / rows.length).toFixed(1);
  console.log(
    `${name.padEnd(22)} ` + KEYS.map((k) => `${k}=${avg(k)}`).join('  ')
  );
}
fs.writeFileSync(
  path.join(path.dirname(here), '.logs', 'measure-last.json'),
  JSON.stringify(results, null, 2)
);
