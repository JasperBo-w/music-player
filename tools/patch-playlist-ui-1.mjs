/*
 * 歌单增删改的界面。
 *
 * 四处：
 *   ① 我的歌单页 → 第一张卡是「+ 新建歌单」
 *   ② 每张歌单卡右上角 → hover 出 ✕（删除歌单）
 *   ③ 歌单内每行 → hover 出「移出歌单」
 *   ④ 搜索结果每行 → hover 出「加到歌单」
 *
 * 两个弹层是自己搭的：**Electron 不支持 window.prompt()**
 *（会直接返回 null 并在控制台报 "prompt() is and will not be supported"），
 * 所以文本输入必须用 DOM 自己做。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const f = path.join(root, 'apps', 'ui', 'src', 'main.js');
let t = fs.readFileSync(f, 'utf8');
const log = (m) => console.log(m);
const rep = (from, to, label) => {
  if (!t.includes(from)) {
    log('!! 未匹配: ' + label);
    return false;
  }
  t = t.replace(from, to);
  log('ok: ' + label);
  return true;
};

// ---------- ① 两个弹层 + 歌单操作 ----------
rep(
  'function renderRows(container, songs, opts = {}) {',
  `/* ------------------------------------------------------------------ */
/* 歌单编辑：轻量弹层                                                  */
/* ------------------------------------------------------------------ */

/**
 * 通用弹层：标题 + 一段内容 + 取消。
 * 返回 { overlay, body, close }，调用方决定内容。
 *
 * 不用 window.prompt / confirm：Electron 里 prompt() 是不支持的
 *（返回 null 并在控制台报错），confirm() 能弹但样式和整体完全不一致。
 */
function mpModal(title) {
  const overlay = document.createElement('div');
  overlay.className = 'mp-modal-overlay';
  const box = document.createElement('div');
  box.className = 'mp-modal';
  const h = document.createElement('div');
  h.className = 'mp-modal-title';
  h.textContent = title;
  const body = document.createElement('div');
  body.className = 'mp-modal-body';
  const foot = document.createElement('div');
  foot.className = 'mp-modal-foot';
  const cancel = document.createElement('button');
  cancel.className = 'mp-btn';
  cancel.type = 'button';
  cancel.textContent = '取消';
  foot.appendChild(cancel);

  box.appendChild(h);
  box.appendChild(body);
  box.appendChild(foot);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  return { overlay, body, foot, close };
}

/** 文本输入弹层 */
function askText(title, placeholder, initial, onOk) {
  const m = mpModal(title);
  const input = document.createElement('input');
  input.className = 'mp-input';
  input.type = 'text';
  input.placeholder = placeholder || '';
  input.value = initial || '';
  input.maxLength = 40;
  m.body.appendChild(input);

  const ok = document.createElement('button');
  ok.className = 'mp-btn mp-btn-primary';
  ok.type = 'button';
  ok.textContent = '确定';
  m.foot.appendChild(ok);

  const submit = () => {
    const v = input.value.trim();
    if (!v) {
      input.focus();
      return;
    }
    m.close();
    onOk(v);
  };
  ok.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  setTimeout(() => input.focus(), 0);
}

/** 选一个歌单（用于「加到歌单」） */
function pickPlaylist(title, onPick) {
  const m = mpModal(title);
  const lists = state.playlists || [];
  if (!lists.length) {
    m.body.innerHTML = '<div class="mp-empty">没有歌单，先去「我的歌单」建一个</div>';
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'mp-list';
  for (const p of lists) {
    const item = document.createElement('button');
    item.className = 'mp-list-item';
    item.type = 'button';
    item.textContent = p.name + '（' + (p.count || 0) + ' 首）';
    item.addEventListener('click', () => {
      m.close();
      onPick(p);
    });
    wrap.appendChild(item);
  }
  m.body.appendChild(wrap);
}

/** 改完歌单后统一收尾：重新拉列表 + 提示 */
async function afterPlaylistChange(msg) {
  state.playlists = [];   // 强制重新拉，避免本地和服务器不一致
  playlistsRendered = false;
  await loadPlaylists();
  if (msg) toast(msg);
}

function renderRows(container, songs, opts = {}) {`,
  '① 弹层 + 收尾'
);

// ---------- ② renderRows 加每行的操作按钮 ----------
rep(
  `      const locked = Number(s.privilege) >= 9;
      return \`<div class="row\${locked ? ' locked' : ''}" data-i="\${i}" title="\${esc(s.name)} — \${esc(s.artist)}">
        <span class="row-idx">\${String(i + 1).padStart(2, '0')}</span>
        <span class="row-name">\${esc(s.name)}\${locked ? ' 🔒' : ''}</span>
        <span class="row-artist">\${esc(s.artist)}</span>
        <span class="row-dur">\${fmtDur(s.durationSec)}</span>
      </div>\`;`,
  `      const locked = Number(s.privilege) >= 9;
      /*
       * 行尾的操作按钮。两个场景互斥：
       *   在歌单里（opts.listId）→ 移出歌单（删歌要 fileId，没有就不给按钮）
       *   搜索结果（opts.addable）→ 加到歌单
       */
      let act = '';
      if (opts.listId) {
        act = Number(s.fileId)
          ? '<button class="row-act" data-act="remove" title="移出歌单">✕</button>'
          : '';
      } else if (opts.addable) {
        act = '<button class="row-act" data-act="add" title="加到歌单">＋</button>';
      }
      return \`<div class="row\${locked ? ' locked' : ''}" data-i="\${i}" title="\${esc(s.name)} — \${esc(s.artist)}">
        <span class="row-idx">\${String(i + 1).padStart(2, '0')}</span>
        <span class="row-name">\${esc(s.name)}\${locked ? ' 🔒' : ''}</span>
        <span class="row-artist">\${esc(s.artist)}</span>
        <span class="row-dur">\${fmtDur(s.durationSec)}</span>
        <span class="row-actions">\${act}</span>
      </div>\`;`,
  '② 行内操作按钮'
);

// ---------- ③ renderRows 的事件：操作按钮优先于播放 ----------
rep(
  `  container.querySelectorAll('.row').forEach((el) => {
    el.addEventListener('click', () => {`,
  `  /*
   * 操作按钮的点击必须**先于**播放处理，而且要阻止冒泡 ——
   * 否则点「移出歌单」会顺带把这首歌播起来，那是最容易让人恼火的一类 bug。
   */
  container.querySelectorAll('.row-act').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.row');
      const song = songs[Number(row.dataset.i)];
      if (!song) return;
      if (btn.dataset.act === 'remove') {
        btn.disabled = true;
        try {
          await api.playlistRemoveTracks(opts.listId, [song.fileId]);
          toast('已移出歌单');
          // 本地先摘掉，避免整页重排导致滚动位置丢失
          row.remove();
        } catch (err) {
          btn.disabled = false;
          toast('移出失败：' + err.message);
        }
      } else if (btn.dataset.act === 'add') {
        // 歌单列表可能还没拉过（比如直接从首页搜索），先保证有
        if (!state.playlists || !state.playlists.length) {
          try {
            state.playlists = await api.playlists();
          } catch (err) {
            toast('拉取歌单失败：' + err.message);
            return;
          }
        }
        pickPlaylist('加到歌单', async (p) => {
          try {
            await api.playlistAddTracks(p.id, [song]);
            toast('已加到「' + p.name + '」');
          } catch (err) {
            toast('添加失败：' + err.message);
          }
        });
      }
    });
  });

  container.querySelectorAll('.row').forEach((el) => {
    el.addEventListener('click', () => {`,
  '③ 行内操作事件'
);

// ---------- ④ 搜索结果允许加歌 ----------
rep(
  `        const songs = await api.playlistTracks(card.dataset.id);
        renderRows(box, songs, { queueTitle: card.dataset.name });`,
  `        const songs = await api.playlistTracks(card.dataset.id);
        // 传 listId → 每行出现「移出歌单」
        renderRows(box, songs, { queueTitle: card.dataset.name, listId: card.dataset.id });`,
  '④a 歌单内渲染带 listId'
);

fs.writeFileSync(f, t);
console.log('done');
