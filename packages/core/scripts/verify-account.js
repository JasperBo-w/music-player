'use strict';

/**
 * 登录态下的完整验证
 *   账号信息 → 我的歌单 → 歌单歌曲 → 播放地址 → 逐字歌词
 *
 * 这是用户核心需求的最终验收：用他自己的账号，走完整条路。
 */

const https = require('node:https');
const http = require('node:http');
const { KuGouClient } = require('../src/index.js');
const { FileSessionStore } = require('../src/session-store.js');
const path = require('node:path');

const store = new FileSessionStore(path.join(__dirname, '..', '.session.json'));
const saved = store.load();

if (!saved.session || !saved.session.token) {
  console.error('没有登录态，请先运行 node scripts/login-qr.js');
  process.exit(1);
}

const client = new KuGouClient({
  device: saved.device,
  session: saved.session,
  onSessionChange: (s) => store.save({ device: client.device, session: s }),
});

function probeAudio(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { Range: 'bytes=0-4095', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          type: res.headers['content-type'],
          bytes: buf.length,
          magic: buf.subarray(0, 3).toString('hex'),
          isAudio: buf.length >= 2 && (buf[0] === 0xff || buf.subarray(0, 3).toString('ascii') === 'ID3'),
        });
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

/** 在对象里按候选键名找第一个非空值 */
const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

const hr = (t) => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72));

(async () => {
  // ---------- 1. 账号 ----------
  hr('1. 账号信息');
  const detail = await client.call('user_detail');
  const u = detail.body && detail.body.data;
  console.log(`  昵称   : ${pick(u, 'nickname')}`);
  console.log(`  userid : ${pick(u, 'userid')}`);
  console.log(`  VIP    : ${pick(u, 'vip_type')}  (0 = 非会员)`);

  // ---------- 2. 我的歌单 ----------
  hr('2. 我的歌单');
  const plRes = await client.getUserPlaylists({ page: 1, pagesize: 60 });
  const plData = plRes.body && plRes.body.data;
  const playlists = (plData && (plData.info || plData.list || plData.lists)) || [];

  console.log(`  共 ${playlists.length} 个\n`);
  console.log('  第一个歌单的原始结构（用于确定字段名）:');
  console.log('  ' + JSON.stringify(playlists[0]).slice(0, 700));

  console.log('\n  歌单列表:');
  playlists.forEach((p, i) => {
    const name = pick(p, 'name', 'list_create_list_name', 'specialname', 'playlist_name');
    const count = pick(p, 'song_count', 'songcount', 'count', 'total', 'm_count');
    const id = pick(p, 'global_collection_id', 'list_create_gid', 'list_create_listid', 'specialid', 'id', 'listid');
    console.log(`     [${String(i).padStart(2)}] ${String(name).slice(0, 34).padEnd(36)} ${count !== undefined ? count + ' 首' : ''}   id=${id}`);
  });

  // ---------- 3. 选一个歌单拉歌曲 ----------
  // 优先选「我喜欢」，否则取第一个有 global_collection_id 的。
  // 注意：必须用 global_collection_id（形如 collection_3_<uid>_<n>_0），
  // 用 list_create_listid（纯数字的客户端本地编号）会报 20010 get other list file fail。
  const gidOf = (p) => pick(p, 'global_collection_id', 'list_create_gid');

  const target =
    playlists.find((p) => gidOf(p) && /我喜欢/.test(String(pick(p, 'name', 'list_create_list_name', 'specialname') || ''))) ||
    playlists.find((p) => gidOf(p));

  if (!target) { console.log('\n没有可用歌单'); return; }

  const targetName = pick(target, 'name', 'list_create_list_name', 'specialname', 'playlist_name');
  const targetId = gidOf(target);

  hr(`3. 歌单《${targetName}》的歌曲 (id=${targetId})`);
  const tr = await client.getPlaylistTracks(targetId, { page: 1, pagesize: 30 });
  const trData = tr.body && (tr.body.data || tr.body);
  const songs = (trData && (trData.songs || trData.info || trData.lists || trData.list || trData.audios)) || [];

  console.log(`  拿到 ${Array.isArray(songs) ? songs.length : 0} 首`);
  if (Array.isArray(songs) && songs[0]) {
    console.log('\n  第一首的原始结构:');
    console.log('  ' + JSON.stringify(songs[0]).slice(0, 800));
  }

  if (Array.isArray(songs) && songs.length) {
    console.log('\n  歌曲列表（前 12）:');
    songs.slice(0, 12).forEach((s, i) => {
      const name = pick(s, 'songname', 'song_name', 'name', 'audio_name', 'filename');
      const hash = pick(s, 'hash', 'file_hash', 'FileHash');
      const artist = pick(s, 'singername', 'singer_name', 'author_name');
      console.log(`     [${String(i).padStart(2)}] ${String(name).slice(0, 30).padEnd(32)} ${String(artist || '').slice(0, 14).padEnd(16)} ${hash ? String(hash).slice(0, 10) : '无hash'}`);
    });
  }

  // ---------- 4. 播放 ----------
  hr('4. 从歌单播放');
  const candidates = (Array.isArray(songs) ? songs : []).filter((s) => pick(s, 'hash', 'file_hash', 'FileHash'));

  if (!candidates.length) {
    console.log('  歌单里没有带 hash 的歌，跳过播放测试');
    return;
  }

  for (const s of candidates.slice(0, 5)) {
    const name = pick(s, 'songname', 'song_name', 'name', 'audio_name', 'filename');
    const hash = pick(s, 'hash', 'file_hash', 'FileHash');
    const albumId = pick(s, 'album_id', 'albumid', 'albumId') || 0;
    const albumAudioId = pick(s, 'album_audio_id', 'audio_id', 'audioid', 'mixsongid') || 0;

    console.log(`\n  --- ${String(name).slice(0, 40)} ---`);
    const stream = await client.getSongStream({ hash, albumId, albumAudioId, quality: 128 });

    if (stream.url) {
      const p = await probeAudio(stream.url);
      console.log(`      ✅ 可播放  来源=${stream.source}  协议=${stream.url.split(':')[0]}  ext=${stream.extName}`);
      console.log(`         ${stream.url.slice(0, 90)}…`);
      console.log(`         实测: HTTP ${p.status} ${p.type} ${p.bytes}B 魔数=${p.magic} ${p.isAudio ? '真音频' : '异常'}`);

      // 歌词
      const artist = pick(s, 'singername', 'singer_name', 'author_name');
      const lyric = await client.getLyric({ name, artist, hash });
      console.log(`         歌词: ${lyric.ok ? `✅ ${lyric.format} 逐字=${lyric.isWordByWord} 长度=${lyric.text.length}` : '❌ 未取到'}`);

      // 试更高音质
      for (const q of [320, 'flac']) {
        const hq = await client.getSongStream({ hash, albumId, albumAudioId, quality: q });
        console.log(`         音质 ${q}: ${hq.url ? '✅ 可用' : `⛔ ${hq.failProcess.join(',') || '受限'}`}`);
      }
      break;
    } else {
      console.log(`      ⛔ 受限: ${stream.failProcess.join(',') || '未知'}`);
    }
  }

  hr('完成');
})().catch((e) => {
  console.error('\n[异常]', e && e.message ? e.message : e);
  if (e && e.body) console.error(JSON.stringify(e.body).slice(0, 600));
  process.exit(1);
});
