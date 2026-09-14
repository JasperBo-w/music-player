/*
 * 播放队列的拖拽排序。
 *
 * 三个容易出错的地方，都处理了：
 *
 * ① **不能把"点击播放"弄坏。** 现在点一下队列项就播那首。
 *    加了拖拽之后，按下再抬起也会走这条路径 —— 所以要用位移阈值区分：
 *    没超过 5px 就是点击，超过才算拖拽，并且拖拽之后要**吞掉那次 click**。
 *
 * ② **重排之后"正在播放"那首不能变。** state.index 是个下标，
 *    队列一动它就指到别的歌上去了。重排后要按**歌曲对象**重新定位 index，
 *    而不是让下标自生自灭。
 *
 * ③ 指针可能松在队列面板外面。所以按下/移动监听在面板上，
 *    抬起监听在 window 上 —— 否则拖出去松手就"粘住"了。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = require('node:path').join(__dirname, '..');
const uiFile = path.join(root, 'apps', 'ui', 'src', 'main.js');
const cssFile = path.join(root, 'apps', 'ui', 'src', 'styles.css');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① 逻辑 ----------
{
  let t = readNorm(uiFile);
  if (t.includes('function moveQueueItem')) {
    log('逻辑已存在');
  } else {
    const anchor = `$('#queue-chip').addEventListener('click', (e) => {`;
    const block = `/* ------------------------------------------------------------------ */
/* 队列拖拽排序                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把队列里第 from 项移到 to 位置之前。
 *
 * to 是**原数组里**的插入位置（插到第 to 项之前）。
 * 因为先删掉了 from，后面所有下标会左移一位，所以要减一 ——
 * 不减的话往后拖永远差一格。
 */
function moveQueueItem(from, to) {
  const q = state.queue;
  if (from < 0 || from >= q.length) return;
  const dest = to > from ? to - 1 : to;
  if (dest === from) return;
  const [item] = q.splice(from, 1);
  q.splice(Math.max(0, Math.min(q.length, dest)), 0, item);

  /*
   * ★ 按**歌曲对象**重新定位 state.index。
   *
   * state.index 是个下标，队列一动它就指到别的歌上去了 ——
   * 表现是"拖完顺序，正在播放的高亮跑到别的歌上"。
   * 用对象引用去找才是对的。
   */
  const cur = state.currentSong;
  if (cur) {
    const at = q.indexOf(cur);
    if (at >= 0) state.index = at;
  }
  renderQueue();
  saveQueueSoon();
}

/** 由指针的 Y 坐标算出"该插到哪一项之前" */
function queueInsertIndexAt(box, clientY) {
  const items = Array.from(box.querySelectorAll('.mini-queue-item'));
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return items.length;
}

let qDrag = null;
/** 拖过之后要吞掉紧随其后的那次 click（否则松手就播了那首） */
let qSuppressClick = false;

{
  const box = $('#queue-list');

  box.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.mini-queue-item');
    if (!el || e.button !== 0) return;
    qDrag = { from: Number(el.dataset.i), startY: e.screenY, moved: false, el, to: null };
  });

  box.addEventListener('pointermove', (e) => {
    if (!qDrag) return;
    // 5px 阈值：以下算点击，以上才算拖拽
    if (!qDrag.moved && Math.abs(e.screenY - qDrag.startY) < 5) return;
    if (!qDrag.moved) {
      qDrag.moved = true;
      qDrag.el.classList.add('dragging');
    }
    const to = queueInsertIndexAt(box, e.clientY);
    if (to === qDrag.to) return;
    qDrag.to = to;
    // 只在目标位置画一条落点线，不做花哨的实时位移
    box.querySelectorAll('.mini-queue-item').forEach((it, i) => {
      it.classList.toggle('drop-before', i === to);
    });
  });

  // 抬起监听在 window 上：拖到面板外面松手也要能收尾
  window.addEventListener('pointerup', (e) => {
    if (!qDrag) return;
    const d = qDrag;
    qDrag = null;
    d.el.classList.remove('dragging');
    box.querySelectorAll('.mini-queue-item').forEach((it) => it.classList.remove('drop-before'));
    if (!d.moved) return; // 只是点击，交给 click 处理

    // ★ 吞掉这次 click —— 否则松手会立刻播放拖过的那首
    qSuppressClick = true;
    setTimeout(() => {
      qSuppressClick = false;
    }, 0);

    if (d.to != null) moveQueueItem(d.from, d.to);
  });
}

${anchor}`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, block);
      log('ok: 拖拽逻辑');
    } else {
      log('!! 没找到 queue-chip 锚点');
    }
  }

  // 点击处理里加上"拖过就吞掉"
  const oldClick = `    el.addEventListener('click', () => {
      closeChipMenus();
      playAt(Number(el.dataset.i));
    });`;
  const newClick = `    el.addEventListener('click', () => {
      // 刚拖过就别播 —— 松手那一下会补一个 click 上来
      if (qSuppressClick) return;
      closeChipMenus();
      playAt(Number(el.dataset.i));
    });`;
  if (t.includes(oldClick)) {
    t = t.replace(oldClick, newClick);
    log('ok: click 里加吞掉判断');
  } else {
    log('!! 队列项的 click 没匹配');
  }

  writeNorm(uiFile, t);
}

// ---------- ② 样式 ----------
{
  let c = fs.readFileSync(cssFile, 'utf8');
  if (c.includes('.mini-queue-item.dragging')) {
    log('样式已存在');
  } else {
    c += `

/* 队列拖拽排序：被拖的那项压暗，落点画一条强调色细线 */
.mini-queue-item.dragging { opacity: .45; }
.mini-queue-item.drop-before { box-shadow: inset 0 2px 0 var(--accent-ink, var(--accent)); }
.mini-queue-item { touch-action: none; }
`;
    fs.writeFileSync(cssFile, c);
    log('ok: 样式');
  }
}

console.log('done');
