/*
 * 设置面板分类。
 *
 * 用户反馈："你这个设置做的有点乱了，太杂了，最好加个分类"。
 *
 * 做法上刻意**不动各段的构建代码** —— 五段小节（外观 / 粒子效果 / 音频驱动 /
 * 流畅度 / 透明）照旧按顺序建好，然后在末尾**按标题把它们搬进分类页**。
 * 好处是新增一段只要在 GROUPS 里登记一行，不用去改构建逻辑，
 * 也不会因为分组把现有的绑定关系（比如 slider 的 id）搞乱。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const log = (m) => console.log(m);

// ---------------- settings-panel.js ----------------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'settings-panel.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('sp-tabs')) {
    log('panel: 已存在分类，跳过');
  } else {
    const anchor = '  body.appendChild(secGlass.root);';
    if (!t.includes(anchor)) {
      log('!! panel: 未找到插入点');
    } else {
      const block = `${anchor}

  /*
   * ============ 分类 ============
   *
   * 原来五段小节全平铺在一列里，滚很久才找得到东西 ——
   * 用户的原话是"太乱了，太杂了"。
   * 这里在它们都建好之后按标题搬进分类页；各段的构建代码一行没动。
   */
  const GROUPS = [
    { id: 'look', name: '外观', titles: ['外观', '透明'] },
    { id: 'fx', name: '效果', titles: ['粒子效果'] },
    { id: 'beat', name: '节奏', titles: ['音频驱动'] },
    { id: 'perf', name: '性能', titles: ['流畅度'] },
    { id: 'keys', name: '热键', titles: ['全局热键'] },
  ];
  const tabs = el('div', 'sp-tabs');
  const pages = new Map();
  for (const g of GROUPS) {
    const btn = el('button', 'sp-tab');
    btn.type = 'button';
    btn.textContent = g.name;
    btn.dataset.group = g.id;
    btn.addEventListener('click', () => showGroup(g.id));
    tabs.appendChild(btn);
    const page = el('div', 'sp-page');
    page.dataset.group = g.id;
    pages.set(g.id, page);
  }

  /*
   * 按标题把小节搬进分类。
   * 用 :scope > 是为了只取直接子级 —— 小节里面还嵌着别的 section 时，
   * 不加这句会把内层的也一起搬到别的页里去。
   */
  for (const sec of Array.from(body.querySelectorAll(':scope > .sp-section'))) {
    const h3 = sec.querySelector('h3');
    const title = h3 ? h3.textContent.trim() : '';
    const g = GROUPS.find((x) => x.titles.includes(title));
    if (!g) continue;   // 没登记的段落留在原地，不会被弄丢
    pages.get(g.id).appendChild(sec);
  }

  // 先把还没被搬走的小节摘出来（否则会被 textContent='' 一起清掉）
  const leftOver = Array.from(body.querySelectorAll(':scope > .sp-section'));
  body.textContent = '';
  body.appendChild(tabs);
  for (const g of GROUPS) body.appendChild(pages.get(g.id));
  for (const s of leftOver) body.appendChild(s);   // 未登记的追加到最后，不至于消失

  function showGroup(id) {
    for (const [k, p] of pages) p.hidden = k !== id;
    for (const b of Array.from(tabs.children)) {
      b.classList.toggle('active', b.dataset.group === id);
    }
  }
  showGroup(GROUPS[0].id);
  panelApi.showGroup = showGroup;`;
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
  if (c.includes('.sp-tabs')) {
    log('css: 已存在');
  } else {
    c += `

/* ------------------------------------------------------------------ */
/* 设置面板：分类页签                                                   */
/* ------------------------------------------------------------------ */
/*
 * 之前五段小节平铺在一列里，要找"磨砂"得滚过主题、效果、节拍……
 * 现在是页签切换，一屏只放一类。
 */
.sp-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 2px 10px;
  position: sticky;
  top: 0;
  z-index: 2;
  background: linear-gradient(var(--glass-bg, rgba(12, 14, 20, 0.96)) 72%, transparent);
}
.sp-tab {
  appearance: none;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: var(--fg-dim, rgba(255, 255, 255, 0.66));
  border-radius: 999px;
  padding: 5px 13px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.sp-tab:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.07)); }
.sp-tab.active {
  color: var(--accent, #7cc6ff);
  border-color: var(--accent, #7cc6ff);
  background: color-mix(in srgb, var(--accent, #7cc6ff) 14%, transparent);
}
`;
    fs.writeFileSync(f, c);
    log('css: ok');
  }
}

console.log('done');
