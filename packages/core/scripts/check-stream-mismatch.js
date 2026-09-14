'use strict';

/**
 * 诊断：点「我喜欢」里的歌，是不是"取流取错了"
 *
 * 三层验证：
 *   1. 歌单里的原始字段长什么样（hash / album_audio_id / album_id 到底在哪）
 *   2. 逐首取流，把返回的 URL 两两比对 —— 全不相同才说明取流是"按 hash 走"的
 *   3. 把 URL 里内嵌的 hash 抠出来，跟请求的 hash 对照
 *
 * 用途：区分"放错歌"是 core 取流的问题，还是界面队列索引的问题。
 */

const path = require('node:path');
const { KuGouClient } = require('../src/index.js');
const { FileSessionStore } = require('../src/session-store.js');

const store = new FileSessionStore(
  process.env.MUSIC_SESSION_FILE || path.join(__dirname, '..', '.session.json')
);
const saved = store.load();

if (!saved.session || !saved.session.token) {
  console.error('没有登录态，请先运行 node scripts/login-qr.js');
  process.exit(1);
}

const client = new KuGouClient({ device: saved.device, session: saved.session });
const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

(async () => {
  // ---- 1. 找「我喜欢」 ----
  const plRes = await client.getUserPlaylists({ page: 1, pagesize: 100 });
  const lists = (plRes.body.data && (plRes.body.data.info || plRes.body.data.list)) || [];
  const fav = lists.find((p) => String(pick(p, 'name')) === '我喜欢');
  if (!fav) {
    console.error('没找到「我喜欢」歌单，现有：', lists.map((p) => pick(p, 'name')).join('、'));
    process.exit(1);
  }
  const gid = pick(fav, 'global_collection_id');
  console.log(`「我喜欢」 声明 ${pick(fav, 'm_count')} 首  gid=${gid}\n`);

  // ---- 2. 拉曲目，并把**原始对象**打出来 ----
  const res = await client.getPlaylistTracks(gid, { page: 1, pagesize: 4 });
  const data = (res.body && (res.body.data || res.body)) || {};
  const raw = data.songs || data.info || data.lists || data.list || data.audios || [];
  if (!raw.length) {
    console.error('没返回歌曲。字段：', Object.keys(data).join(', '));
    console.error(JSON.stringify(res.body).slice(0, 400));
    process.exit(1);
  }

  console.log('=== 原始曲目字段（第 1 首，全量） ===');
  console.log(JSON.stringify(raw[0], null, 2).slice(0, 1400));

  const songs = raw.map((s) => ({
    name: pick(s, 'name', 'songname', 'filename') || '?',
    artist: pick(s, 'singername', 'singer_name', 'author_name') || '?',
    hash: String(pick(s, 'hash', 'audio_hash', 'file_hash') || ''),
    albumId: pick(s, 'album_id', 'albumid') || 0,
    albumAudioId: pick(s, 'album_audio_id', 'mixsongid', 'audio_id') || 0,
  }));

  console.log('\n=== 取流测试 ===');
  songs.forEach((s, i) => {
    console.log(`[${i}] 《${s.name}》 hash=${s.hash} (长度 ${s.hash.length})  albumId=${s.albumId}  albumAudioId=${s.albumAudioId}`);
  });
  console.log('');

  const results = [];
  for (const s of songs) {
    let out;
    try {
      out = await client.getSongStream({
        hash: s.hash,
        albumId: s.albumId,
        albumAudioId: s.albumAudioId,
        quality: 128,
      });
    } catch (e) {
      out = { url: null, err: e.message };
    }
    results.push({ song: s, out });
    console.log(`《${s.name}》 source=${out.source || '-'}`);
    console.log(`   ${out.url || `失败：${out.err || (out.failProcess || []).join('、')}`}\n`);
  }

  // ---- 3. 判定 ----
  const urls = results.map((r) => r.out.url).filter(Boolean);
  const uniq = new Set(urls);
  console.log('='.repeat(62));
  if (!urls.length) {
    console.log('一首都没取到流，这个测试说明不了问题（多半是付费/版权限制）');
  } else if (uniq.size === urls.length) {
    console.log(`✓ 取流正常：${urls.length} 首拿到 ${uniq.size} 个各不相同的地址`);
    console.log('  → "放错歌"跟取流无关，问题在界面侧（队列索引 / audio 元素）');
  } else {
    console.log(`✗ 取流有问题：${urls.length} 首只拿到 ${uniq.size} 个不同地址`);
    console.log('  → 取流端点忽略了 hash，问题在 core');
    for (const u of uniq) {
      const who = results.filter((r) => r.out.url === u).map((r) => `《${r.song.name}》`);
      console.log(`   ${who.join(' / ')}\n     ${u}`);
    }
  }

  console.log('\n=== URL 内嵌 hash 与请求 hash 对照 ===');
  const short = (h) => (h && h.length > 12 ? `${h.slice(0, 12)}…(${h.length})` : h);
  for (const r of results) {
    if (!r.out.url) continue;
    const m = r.out.url.match(/\/([0-9A-Fa-f]{16,32})\//);
    const inUrl = m ? m[1].toUpperCase() : '(URL 里没有 hash)';
    const req = String(r.song.hash).toUpperCase();
    const same = inUrl === req;
    console.log(`  ${same ? '一致  ' : '不一致'}  请求=${short(req)}  URL=${short(inUrl)}  《${r.song.name}》`);
  }
})().catch((e) => {
  console.error('脚本出错：', e);
  process.exit(1);
});
