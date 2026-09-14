/*
 * 左键双击 → 相机归位（平滑滑回正面）。
 *
 * 用户："虽然自动归位没了，但是还是加个左键双击归位把"。
 *
 * 做法：复用已有的 returning 缓动通道 —— 自动归位关掉之后（延时设成 Infinity），
 * 那条通道就空着，正好拿来当"手动归位"。所以是**平滑滑回**，不是瞬移。
 * 顺带把缩放也跟着回去（"归位"应该包含远近）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pf = path.join(path.dirname(here), 'apps', 'ui', 'src', 'particles.js');
let t = fs.readFileSync(pf, 'utf8');
const log = (m) => console.log(m);

// ① bind
if (!t.includes('this._onDblClick = this._onDblClick.bind(this);')) {
  t = t.replace(
    '    this._onWheel = this._onWheel.bind(this);',
    `    this._onWheel = this._onWheel.bind(this);
    this._onDblClick = this._onDblClick.bind(this);`
  );
  log('ok: bind');
} else log('已存在 bind');

// ② listener
if (!t.includes("addEventListener('dblclick'")) {
  t = t.replace(
    "    window.addEventListener('wheel', this._onWheel, { passive: false });",
    `    window.addEventListener('wheel', this._onWheel, { passive: false });

    /*
     * 左键双击归位。
     * 自动归位已经按要求关掉了（ORBIT_RETURN_DELAY_MS = Infinity），
     * 但仍需要一个"回到正面"的入口 —— 双击是最顺手的那个。
     */
    window.addEventListener('dblclick', this._onDblClick);`
  );
  log('ok: listener');
} else log('已存在 listener');

// ③ 方法
if (!t.includes('_onDblClick(e) {')) {
  t = t.replace(
    '  _onOrbitDown(e) {',
    `  /**
   * 双击归位：平滑滑回正面，并把缩放恢复到默认。
   *
   * 直接置 0 是瞬移，会让人不知道发生了什么；所以走 returning 那条缓动
   * （自动归位关掉之后它就空着）。半径的一并归位也放在那段里。
   */
  _onDblClick(e) {
    const o = this.orbit;
    if (!o) return;
    // 落在界面控件上的双击不算（和拖动、滚轮同一套判据）
    const t2 = e.target;
    if (t2 && t2.closest && t2.closest(ORBIT_UI_SELECTOR)) return;
    o.dragging = false;
    o.lastActiveAt = performance.now();
    o.returning = true;
    if (window.__mpMark) window.__mpMark('双击归位');
  }

  _onOrbitDown(e) {`
  );
  log('ok: 方法');
} else log('已存在 方法');

// ④ 缓动里加上半径
const fromEase = `      const t = Math.min(1, dt * ORBIT_RETURN_SPEED);
      o.az += (0 - o.az) * t;
      o.el += (0 - o.el) * t;`;
const toEase = `      const t = Math.min(1, dt * ORBIT_RETURN_SPEED);
      o.az += (0 - o.az) * t;
      o.el += (0 - o.el) * t;
      // 缩放也跟着回家（"归位"应该包含远近）
      o.radius += (ORBIT_HOME_RADIUS - o.radius) * t;`;
if (t.includes(fromEase) && !t.includes('ORBIT_HOME_RADIUS - o.radius')) {
  t = t.replace(fromEase, toEase);
  log('ok: 缓动加半径');
} else log('缓动段: 已处理或未匹配');

// ⑤ 常量
if (!t.includes('ORBIT_HOME_RADIUS')) {
  t = t.replace(
    'const EL_LIMIT = 1.5533;',
    `const EL_LIMIT = 1.5533;
/** 双击归位时的默认轨道半径（和构造函数里的初值一致） */
const ORBIT_HOME_RADIUS = 9;`
  );
  log('ok: 常量');
}

// ⑥ dispose
if (!t.includes("removeEventListener('dblclick'")) {
  t = t.replace(
    "    window.removeEventListener('wheel', this._onWheel);",
    `    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('dblclick', this._onDblClick);`
  );
  log('ok: dispose');
}

fs.writeFileSync(pf, t);
console.log('done');
