/*
 * 用 CDP 给另一个 Electron 应用截图 / 查状态。
 *
 * 为什么不用 Win32 抓窗口：Mineradio 是 DirectComposition 窗口，
 * PrintWindow 拿回来的尺寸是错的（窗口 1721x1081，抓出来恒为 1282x722，
 * 内容还被裁掉）—— 拿这种图去对比等于白看。
 * 走 CDP 拿到的是渲染器自己的帧，精确、不受遮挡影响，还能顺便执行 JS
 * 去点它的界面、切它的视图。
 *
 * Node 24 自带 WebSocket，不需要任何依赖。
 *
 * 用法：
 *   node tools/cdp.mjs --list
 *   node tools/cdp.mjs --out a.png [--eval "<js>"] [--wait 2000] [--port 9222]
 */
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (name) => args.includes('--' + name);

const port = Number(opt('port', 9222));
const base = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const r = await fetch(base + '/json');
  return r.json();
}

if (has('list')) {
  const t = await targets();
  for (const x of t) {
    console.log(`${x.type}\t${x.title}\t${x.url}\t${x.webSocketDebuggerUrl || ''}`);
  }
  process.exit(0);
}

const list = await targets();
const page = list.find((t) => t.type === 'page') || list[0];
if (!page || !page.webSocketDebuggerUrl) {
  console.error('没有可用的 page target');
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败，端口开对了吗？')), { once: true });
});

const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(method + ' 超时'));
      }
    }, 30000);
  });

await call('Page.enable').catch(() => {});

const js = opt('eval', '');
if (js) {
  const r = await call('Runtime.evaluate', {
    expression: js,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log('eval →', JSON.stringify(r.result && r.result.value));
}

await sleep(Number(opt('wait', 1500)));

const size = await call('Runtime.evaluate', {
  expression: "JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,title:document.title})",
  returnByValue: true,
});
console.log('页面 →', size.result && size.result.value);

const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const out = opt('out', '');
if (out) {
  const fs = await import('node:fs');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved →', out, Buffer.from(shot.data, 'base64').length, 'bytes');
}
ws.close();
process.exit(0);
