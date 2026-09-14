/*
 * 热键编辑器（设置面板的「热键」页）。
 *
 * 交互：每行一个动作 —— 名称 / 当前绑定 / 「录制」/「清除」/ 状态。
 * 点录制之后按钮进入"按下组合键…"，下一次 keydown 就是新绑定。
 *
 * 两个必须做的约束：
 *   ① 只按修饰键（Ctrl/Alt/Shift）不算一个组合，要等真正的键
 *   ② 单独一个普通字母/数字**不允许**绑成全局热键 —— 那会把那个键从
 *      整个系统里抢走，用户打字都会触发。函数键（F1~F24）和导航键除外。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const log = (m) => console.log(m);

// ---------------- settings.js：给绑定留存储位 ----------------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'settings.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('hotkeys: {}')) {
    log('settings: 已存在');
  } else {
    const anchor = "  effect: 'cover',";
    if (t.includes(anchor)) {
      t = t.replace(
        anchor,
        anchor +
          `

  /*
   * 全局热键的**用户覆盖表**：{ 动作id: 加速键 }。
   * 只存覆盖项，缺的用代码里的默认值补 —— 于是默认值以后能改，
   * 而用户改过的那些不会被覆盖回去。
   * 值存空串表示"这条显式不绑定"。
   */
  hotkeys: {},`
      );
      fs.writeFileSync(f, t);
      log('settings: ok');
    } else {
      log('!! settings: 未找到 effect 默认值');
    }
  }
}

// ---------------- settings-panel.js：建编辑器 ----------------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'settings-panel.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('secKeys')) {
    log('panel: 已存在');
  } else {
    const anchor = '  body.appendChild(secGlass.root);';
    if (!t.includes(anchor)) {
      log('!! panel: 未找到插入点');
    } else {
      const block = `
  /*
   * ============ 全局热键 ============
   *
   * 必须建在下面的"分类搬移"**之前** —— 搬移是按标题找小节的，
   * 建晚了就找不到它，这一页会是空的（我第一版就是这样）。
   */
  const secKeys = section(
    '全局热键',
    '在任意窗口都生效。点「录制」再按下组合键；「清除」表示不绑定。显示"被占用"说明这个组合被系统或别的软件抢走了'
  );
  body.appendChild(secKeys.root);

  const keyRows = new Map();
  for (const a of opts.hotkeyActions || []) {
    const row = el('div', 'sp-row sp-row-hotkey');
    const name = el('label', 'sp-hotkey-name');
    name.textContent = a.label;
    const cur = el('button', 'sp-hotkey-key');
    cur.type = 'button';
    const rec = el('button', 'sp-hotkey-btn');
    rec.type = 'button';
    rec.textContent = '录制';
    const clr = el('button', 'sp-hotkey-btn');
    clr.type = 'button';
    clr.textContent = '清除';
    const st = el('span', 'sp-hotkey-state');
    row.appendChild(name);
    row.appendChild(cur);
    row.appendChild(rec);
    row.appendChild(clr);
    row.appendChild(st);
    secKeys.body.appendChild(row);
    keyRows.set(a.id, { cur, rec, clr, st, recording: false });

    clr.addEventListener('click', () => {
      opts.onHotkeyChange && opts.onHotkeyChange(a.id, '');
    });
    rec.addEventListener('click', () => startRecording(a.id));
  }

  /** 有没有修饰键 */
  const hasMod = (e) => e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
  /** 函数键与导航键可以单独用（不会抢走打字） */
  const STANDALONE = /^(F([1-9]|1[0-9]|2[0-4])|Home|End|PageUp|PageDown|Insert|Delete|MediaPlayPause|MediaNextTrack|MediaPreviousTrack|MediaStop)$/;

  /** 把一个 keydown 事件转成 Electron 的 accelerator 字符串 */
  function accelFromEvent(e) {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return { pending: true };
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');

    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key === 'ArrowUp') key = 'Up';
    else if (key === 'ArrowDown') key = 'Down';
    else if (key === 'ArrowLeft') key = 'Left';
    else if (key === 'ArrowRight') key = 'Right';
    else if (key === 'Escape') key = 'Esc';
    else if (key.length === 1 && /[a-zA-Z0-9]/.test(key)) key = key.toUpperCase();
    else if (key.length === 1) return { error: '这个符号键请配一个修饰键' };

    /*
     * 没有修饰键时，只允许函数键 / 导航键 / 媒体键。
     * 否则用户录一个 "M" 就会把系统里所有的 M 都抢走 —— 打字都会触发播放。
     */
    if (!mods.length && !STANDALONE.test(key)) {
      return { error: '请加一个修饰键（Ctrl / Alt / Shift）' };
    }
    return { accel: mods.concat([key]).join('+') };
  }

  let recordingId = null;
  function stopRecording() {
    if (recordingId && keyRows.has(recordingId)) {
      const r = keyRows.get(recordingId);
      r.recording = false;
      r.rec.textContent = '录制';
      r.rec.classList.remove('recording');
      r.st.textContent = '';
    }
    recordingId = null;
    window.removeEventListener('keydown', onRecordKey, true);
  }

  function onRecordKey(e) {
    if (recordingId == null) return;
    e.preventDefault();
    e.stopPropagation();
    const id = recordingId;
    const r = keyRows.get(id);
    if (e.key === 'Escape') {
      stopRecording();
      return;
    }
    const got = accelFromEvent(e);
    if (got.pending) {
      r.st.textContent = '继续按…';
      return;
    }
    if (got.error) {
      r.st.textContent = got.error;
      return;
    }
    stopRecording();
    opts.onHotkeyChange && opts.onHotkeyChange(id, got.accel);
  }

  function startRecording(id) {
    stopRecording();
    recordingId = id;
    const r = keyRows.get(id);
    r.recording = true;
    r.rec.textContent = '按下组合键…';
    r.rec.classList.add('recording');
    r.st.textContent = 'Esc 取消';
    // 用捕获阶段，抢在其它键盘处理之前拿到按键
    window.addEventListener('keydown', onRecordKey, true);
  }

  /** 把当前绑定与注册结果刷到界面上 */
  function refreshHotkeys(map, results) {
    const res = new Map((results || []).map((x) => [x.action, x]));
    for (const [id, r] of keyRows) {
      const acc = String((map && map[id]) || '').trim();
      r.cur.textContent = acc || '未绑定';
      r.cur.classList.toggle('unbound', !acc);
      const info = res.get(id);
      if (!acc) r.st.textContent = '';
      else if (!info) r.st.textContent = '';
      else if (info.ok) r.st.textContent = '可用';
      else if (info.reason === 'duplicate') r.st.textContent = '和其它条重复';
      else if (info.reason === 'api-error') r.st.textContent = '接口异常';
      else r.st.textContent = '被占用';
      r.st.classList.toggle('bad', !!info && !info.ok);
    }
  }

` + anchor;
      t = t.replace(anchor, block);
      fs.writeFileSync(f, t);
      log('panel: ok');
    }
  }
}

// ---------------- styles.css ----------------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'styles.css');
  let c = fs.readFileSync(f, 'utf8');
  if (c.includes('.sp-row-hotkey')) {
    log('css: 已存在');
  } else {
    c += `

/* 热键行：名称 / 当前绑定 / 录制 / 清除 / 状态 */
.sp-row-hotkey {
  display: grid;
  grid-template-columns: 1fr auto auto auto auto;
  align-items: center;
  gap: 8px;
}
.sp-hotkey-name { font-size: 13px; }
.sp-hotkey-key {
  appearance: none;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.14));
  background: rgba(255, 255, 255, 0.04);
  color: var(--fg, #eef2f8);
  border-radius: 7px;
  padding: 4px 12px;
  font: inherit;
  font-size: 12px;
  min-width: 104px;
  cursor: default;
}
.sp-hotkey-key.unbound { color: rgba(255, 255, 255, 0.38); }
.sp-hotkey-btn {
  appearance: none;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.14));
  background: transparent;
  color: var(--fg-dim, rgba(255, 255, 255, 0.7));
  border-radius: 999px;
  padding: 4px 11px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.sp-hotkey-btn:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }
.sp-hotkey-btn.recording {
  color: var(--accent, #7cc6ff);
  border-color: var(--accent, #7cc6ff);
}
.sp-hotkey-state { font-size: 12px; color: rgba(255, 255, 255, 0.42); min-width: 88px; }
.sp-hotkey-state.bad { color: #ff8a7a; }
`;
    fs.writeFileSync(f, c);
    log('css: ok');
  }
}

console.log('done');
