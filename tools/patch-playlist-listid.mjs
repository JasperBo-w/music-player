/*
 * 修「写接口用错 id」+ 清掉我留在账号里的测试歌单。
 *
 * 错在哪：
 *   读接口（取歌单曲目）要 global_collection_id，形如 "collection_3_1406398940_26_0"
 *   写接口（加歌/删歌/删歌单）要**数字** list_create_listid，就是 26
 *   我一开始只映射了前者，于是：
 *     · 加歌 → [30203] 未知错误（歌单认不出来）
 *     · 删歌单 → playlist_del 里是 Number(params.listid)，传字符串进去得到 NaN，
 *                接口不会真删，但返回体看着像成功 —— **这是最坏的一种假成功**
 *
 * 修法：mapPlaylist 同时给出两个 id，各用各的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const log = (m) => console.log(m);

// ---------- ① mapPlaylist 补 listid ----------
{
  const f = path.join(root, 'apps', 'desktop', 'main.js');
  let t = fs.readFileSync(f, 'utf8');
  const from = `    id: String(pick(raw, 'global_collection_id', 'list_create_gid', 'specialid', 'id') || ''),`;
  const to = `    id: String(pick(raw, 'global_collection_id', 'list_create_gid', 'specialid', 'id') || ''),
    /*
     * listid —— **写**接口（加歌/删歌/删歌单）要的就是它，数字。
     *
     * 和上面的 id 是两个不同的东西，别混：
     *   id      = global_collection_id，形如 "collection_3_1406398940_26_0"，**读**用
     *   listid  = list_create_listid，形如 26，**写**用
     * 传错的话加歌回 [30203]，删歌单更阴 —— playlist_del 里是 Number(params.listid)，
     * 字符串进去变 NaN，接口不真删却返回得像成功。
     */
    listid: Number(pick(raw, 'list_create_listid', 'listid', 'list_id') || 0),`;
  if (t.includes(from) && !t.includes('listid: Number(pick(raw')) {
    t = t.replace(from, to);
    fs.writeFileSync(f, t);
    log('ok: mapPlaylist 补 listid');
  } else {
    log('mapPlaylist: 已处理或未匹配');
  }
}

// ---------- ② 界面：写操作一律传 listid ----------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'main.js');
  let t = fs.readFileSync(f, 'utf8');
  const rep = (from, to, label) => {
    if (!t.includes(from)) {
      log('!! 未匹配: ' + label);
      return;
    }
    t = t.replace(from, to);
    log('ok: ' + label);
  };

  // 卡片带上数字 listid
  rep(
    `(p) => \`<div class="card" data-id="\${esc(p.id)}" data-name="\${esc(p.name)}">`,
    `(p) => \`<div class="card" data-id="\${esc(p.id)}" data-listid="\${esc(String(p.listid || ''))}" data-name="\${esc(p.name)}">`,
    '卡片带 data-listid'
  );

  // 打开歌单时，行内「移出歌单」要用数字 listid
  rep(
    `        renderRows(box, songs, { queueTitle: card.dataset.name, listId: card.dataset.id });`,
    `        // listId 传**数字** listid（写接口用），不是 data-id（读接口用）
        renderRows(box, songs, { queueTitle: card.dataset.name, listId: card.dataset.listid });`,
    '移出歌单用 listid'
  );

  // 删除歌单用 listid
  rep(
    `            await api.playlistDelete(card.dataset.id);`,
    `            await api.playlistDelete(card.dataset.listid);`,
    '删除歌单用 listid'
  );

  // 加到歌单用 listid
  rep(
    `            await api.playlistAddTracks(p.id, [song]);`,
    `            await api.playlistAddTracks(p.listid, [song]);`,
    '加到歌单用 listid'
  );

  fs.writeFileSync(f, t);
}

console.log('done');
