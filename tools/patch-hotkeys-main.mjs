/*
 * 全局自定义热键 —— 主进程 + 预加载。
 *
 * 机制照 Mineradio 的做法（只学机制，不抄代码）：
 *   ① 整表重来：先全部解绑，再按新表注册 —— 不用去算"哪条改了"
 *   ② 同一组合去重：一个键不能绑两个动作
 *   ③ 逐条回报结果：globalShortcut.register 失败就说明被系统/别的软件占了，
 *      把冲突信息一起回给界面，界面上才有"可用 / 被占用"
 *   ④ 动作不在这里执行，而是 send 回渲染进程 —— 播放器状态都在渲染进程里
 *
 * 另外注册表在 app 退出前必须清空；Electron 会在退出时自动清，
 * 但显式写出来更明确，也方便以后加"临时挂起"（比如进全屏模式时）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const log = (m) => console.log(m);

// ---------------- preload ----------------
{
  const f = path.join(root, 'apps', 'desktop', 'preload.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('hotkeys:')) {
    log('preload: 已存在');
  } else {
    t = t.replace(
      `  /** 无边框窗口控制 */`,
      `  /** 全局热键 */
  hotkeys: {
    /**
     * 用整张绑定表重新配置全局热键。
     * 返回逐条结果（ok / 冲突），界面上的"可用 / 被占用"就是它。
     */
    configure: (bindings) => ipcRenderer.invoke('hotkeys:configure', bindings),
    /**
     * 订阅热键动作。热键在主进程触发，但播放器状态在渲染进程，
     * 所以动作要发回来执行。
     * 返回取消订阅函数 —— 页面重建时不取消会叠加监听。
     */
    onAction: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('hotkeys:action', listener);
      return () => ipcRenderer.removeListener('hotkeys:action', listener);
    },
  },

  /** 无边框窗口控制 */`
    );
    fs.writeFileSync(f, t);
    log('preload: ok');
  }
}

// ---------------- desktop main ----------------
{
  const f = path.join(root, 'apps', 'desktop', 'main.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('registeredGlobalHotkeys')) {
    log('desktop/main: 已存在');
  } else {
    const block = `
/* ------------------------------------------------------------------ */
/* 全局自定义热键                                                      */
/* ------------------------------------------------------------------ */

/** accelerator -> action。用于整表解绑，也用于排查"这个键绑给谁了"。 */
const registeredGlobalHotkeys = new Map();

function sendGlobalHotkeyAction(action) {
  if (!mainWindow || mainWindow.isDestroyed() || !action) return;
  mainWindow.webContents.send('hotkeys:action', { action });
}

function unregisterAllGlobalHotkeys() {
  for (const acc of registeredGlobalHotkeys.keys()) {
    try {
      globalShortcut.unregister(acc);
    } catch {}
  }
  registeredGlobalHotkeys.clear();
}

/**
 * 用整张绑定表重配全局热键，逐条返回结果。
 *
 * 为什么是"整表重来"而不是增量更新：增量的代价是每次改动都要算差集，
 * 而差集算错会留下"已经不该存在的热键还在生效"——那种 bug 很隐蔽
 *（按键还有反应，但界面上已经没这条了）。全解绑再全注册，逻辑只有一条路径。
 */
function configureGlobalHotkeys(bindings) {
  unregisterAllGlobalHotkeys();
  const results = [];
  const seen = new Set();
  for (const item of Array.isArray(bindings) ? bindings : []) {
    const action = item && String(item.action || '').trim();
    const accelerator = item && String(item.accelerator || '').trim();
    if (!action || !accelerator) continue;
    // 同一个组合只能绑一个动作，后面的丢掉（否则注册必然失败，还会报成"被占用"）
    if (seen.has(accelerator)) {
      results.push({ action, accelerator, ok: false, reason: 'duplicate' });
      continue;
    }
    seen.add(accelerator);
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => sendGlobalHotkeyAction(action));
    } catch {
      ok = false;
    }
    if (ok) {
      registeredGlobalHotkeys.set(accelerator, action);
      results.push({ action, accelerator, ok: true });
    } else {
      // 注册失败几乎只有一种原因：被系统或别的软件占用了
      results.push({
        action,
        accelerator,
        ok: false,
        reason: 'taken',
        conflict: { sourceName: '系统 / 其他软件' },
      });
    }
  }
  console.log(
    '[热键] 已注册 ' + registeredGlobalHotkeys.size + ' 条，失败 ' +
      results.filter((r) => !r.ok).length + ' 条'
  );
  return results;
}

ipcMain.handle('hotkeys:configure', (_e, bindings) => configureGlobalHotkeys(bindings));
ipcMain.handle('hotkeys:list', () => Array.from(registeredGlobalHotkeys.entries()));

`;
    const anchor = "  ipcMain.handle('win:minimize'";
    if (t.includes(anchor)) {
      t = t.replace(anchor, block + anchor);
      log('desktop/main: ok');
    } else {
      log('!! desktop/main: 未找到插入点');
    }
  }
  fs.writeFileSync(f, t);
}

console.log('done');
