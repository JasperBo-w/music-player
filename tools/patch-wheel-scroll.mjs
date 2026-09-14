/*
 * 补丁：滚轮缩放不要抢走界面的滚动。
 *
 * 用户原话："打开设置滚动只放大画面，设置里失效"。
 *
 * 根因：_onWheel 挂在 window 上，且**无条件** preventDefault ——
 * 设置面板、歌单列表这些自己需要滚动的区域全被吃掉。
 * 这是典型的"只顾新功能、踩了别人的地盘"。
 *
 * 修法：从事件目标往上找，只要有一个祖先**真的能纵向滚动**
 * （overflowY 是 auto/scroll 且内容确实溢出），就把滚动权让给它。
 * 另外输入控件上也不接管。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(path.dirname(here), 'apps', 'ui', 'src', 'particles.js');
let t = fs.readFileSync(file, 'utf8');

const from = `  _onWheel(e) {
    const o = this.orbit;
    if (!o) return;
    const prev = o.radius;`;

const to = `  _onWheel(e) {
    const o = this.orbit;
    if (!o) return;

    /*
     * ★ 先把滚动权让给"真的能滚的界面"。
     *
     * 这个监听挂在 window 上，如果无条件 preventDefault，
     * 设置面板、歌单列表这些自己需要滚动的区域就会被一起吃掉 ——
     * 用户的原话是"打开设置滚动只放大画面，设置里失效"。
     * 判据：从事件目标往上找，有没有一个祖先**确实**能纵向滚动
     * （overflowY 是 auto/scroll 且内容溢出）。有就让给它。
     */
    const tgt = e.target;
    if (tgt && tgt.closest && tgt.closest('input, textarea, select')) return;
    let el = tgt;
    while (el && el !== document.body && el !== document.documentElement) {
      let st = null;
      try {
        st = getComputedStyle(el);
      } catch {
        st = null;
      }
      if (st && (st.overflowY === 'auto' || st.overflowY === 'scroll')) {
        if (el.scrollHeight > el.clientHeight + 1) return;   // 能滚 → 让给它
      }
      el = el.parentElement;
    }

    const prev = o.radius;`;

if (!t.includes(from)) {
  console.log('!! 未匹配 _onWheel');
  process.exit(1);
}
t = t.replace(from, to);
fs.writeFileSync(file, t);
console.log('ok: 滚轮不再抢界面滚动');
