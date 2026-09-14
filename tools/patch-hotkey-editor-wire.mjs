/*
 * 把热键编辑器接到主流程：
 *   ① 面板 sync 时刷新绑定显示（读 hotkeyMap / hotkeyResults）
 *   ② main.js 传进动作表与变更回调
 *   ③ 变更后立即重新注册，并把结果推回界面
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const log = (m) => console.log(m);
const edit = (file, from, to, label) => {
  let t = fs.readFileSync(file, 'utf8');
  if (!t.includes(from)) {
    log('!! 未匹配: ' + label);
    return;
  }
  t = t.replace(from, to);
  fs.writeFileSync(file, t);
  log('ok: ' + label);
};

const panel = path.join(root, 'apps', 'ui', 'src', 'settings-panel.js');
const main = path.join(root, 'apps', 'ui', 'src', 'main.js');

// ① sync 里刷新热键显示
edit(
  panel,
  '  function sync() {',
  `  function sync() {
    /*
     * 热键那一栏要在每次 sync 时刷新 —— 注册结果是异步从主进程回来的，
     * 不能只在构建时读一次（那时还没有结果）。
     */
    try {
      refreshHotkeys(
        opts.hotkeyMap ? opts.hotkeyMap() : {},
        opts.hotkeyResults ? opts.hotkeyResults() : []
      );
    } catch (e) {
      console.warn('[设置] 刷新热键显示失败:', e && e.message);
    }`,
  'panel: sync 刷新热键'
);

// ② 把 refreshHotkeys 暴露出去（变更后由 main.js 主动推一次）
edit(
  panel,
  '  return { open, close, toggleOpen, isOpen, sync, setFps, overlay };',
  '  return { open, close, toggleOpen, isOpen, sync, setFps, overlay, refreshHotkeys };',
  'panel: 导出 refreshHotkeys'
);

// ③ main.js：传进选项 + 变更回调
edit(
  main,
  `const settingsPanel = mountSettingsPanel({
  getSettings: () => settings,
  update: updateSettings,`,
  `const settingsPanel = mountSettingsPanel({
  getSettings: () => settings,
  update: updateSettings,
  /*
   * 热键编辑器要的三样：动作表、当前生效的绑定、上一次注册的结果。
   * 结果由 applyGlobalHotkeys 写进 globalThis，因为它是异步回来的。
   */
  hotkeyActions: HOTKEY_ACTIONS,
  hotkeyMap: () => ({ ...defaultHotkeyBindings(), ...(settings.hotkeys || {}) }),
  hotkeyResults: () => globalThis.__hotkeyResults || [],
  onHotkeyChange: (id, accel) => setHotkey(id, accel),`,
  'main: 传入热键选项'
);

// ④ main.js：setHotkey 实现（插在 applyGlobalHotkeys 之后）
edit(
  main,
  `/** 订阅主进程发回来的动作。重新注册时先退订，避免监听叠加。 */`,
  `/**
 * 改一条热键绑定：写进设置 → 立刻重新注册 → 把结果推回界面。
 *
 * 存的是**覆盖表**：只记用户改过的那几条，缺的用默认值补。
 * 于是以后要调整默认组合，没被动过的那些会跟着变，改过的不会被覆盖。
 * 空串表示"这条显式不绑定"。
 */
function setHotkey(actionId, accelerator) {
  if (!actionId) return;
  const next = { ...(settings.hotkeys || {}) };
  const acc = String(accelerator || '').trim();
  if (acc) next[actionId] = acc;
  else next[actionId] = '';   // 显式留空，而不是删掉（删掉会退回默认值）
  settings.hotkeys = next;
  saveSettings(settings);
  void applyGlobalHotkeys().then(() => {
    if (settingsPanel && settingsPanel.refreshHotkeys) {
      settingsPanel.refreshHotkeys(
        { ...defaultHotkeyBindings(), ...(settings.hotkeys || {}) },
        globalThis.__hotkeyResults || []
      );
    }
  });
}

/** 订阅主进程发回来的动作。重新注册时先退订，避免监听叠加。 */`,
  'main: setHotkey'
);

console.log('done');
