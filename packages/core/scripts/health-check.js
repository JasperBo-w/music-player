'use strict';

/**
 * 接口健康度体检
 *
 * 目的：不要假设 vendor 里的 215 个接口都还能用。酷狗随时在改，
 * 这里批量打一遍 App 真正会用到的接口，标出哪些可用、哪些已失效。
 * 结果决定 App 的功能边界，也决定搜索该用什么替代方案。
 */

const { KuGouClient } = require('../src/index.js');

const client = new KuGouClient();

/** 判定响应是否「有实质数据」 */
function judge(res) {
  const b = res.body;
  if (b === null || b === undefined) return { ok: false, why: '空响应' };
  if (typeof b === 'string') return { ok: false, why: `返回字符串(前60字): ${b.slice(0, 60)}`, html: b.includes('<!--KG_TAG') };

  const code = b.error_code ?? b.errcode ?? b.errcode;
  if (code && Number(code) !== 0) return { ok: false, why: `error_code=${code} ${b.error_msg || b.error || ''}`.trim() };

  // 找列表长度作为「有数据」的证据
  const probes = [
    ['data.lists', b?.data?.lists],
    ['data.info', b?.data?.info],
    ['data', Array.isArray(b?.data) ? b.data : null],
    ['data.songs', b?.data?.songs],
    ['data.audios', b?.data?.audios],
    ['data.albums', b?.data?.albums],
    ['lists', b?.lists],
  ];
  for (const [path, val] of probes) {
    if (Array.isArray(val)) return { ok: val.length > 0, why: `${path} 有 ${val.length} 条`, count: val.length };
  }
  return { ok: true, why: `无列表但有字段: ${Object.keys(b).slice(0, 6).join(',')}` };
}

const CASES = [
  // 无需登录、无需 id
  ['榜单列表', 'rank_list', {}],
  ['新歌榜', 'top_song', { page: 1, pagesize: 5 }],
  ['推荐歌单', 'top_playlist', { page: 1, pagesize: 5 }],
  ['歌单分类', 'playlist_tags', {}],
  ['每日推荐', 'everyday_recommend', { page: 1, pagesize: 5 }],
  ['推荐歌曲', 'recommend_songs', { page: 1, pagesize: 5 }],
  ['私人FM', 'personal_fm', {}],
  ['搜索(歌)', 'search', { keywords: '周杰伦', page: 1, pagesize: 5 }],
  ['综合搜索', 'search_complex', { keywords: '周杰伦', page: 1, pagesize: 5 }],
  ['混合搜索', 'search_mixed', { keywords: '周杰伦', page: 1, pagesize: 5 }],
  ['搜索联想', 'search_suggest', { keywords: '周杰伦' }],
  ['热搜', 'search_hot', {}],
  ['默认搜索词', 'search_default', {}],
  ['歌词搜索', 'search_lyric', { keywords: '周杰伦', page: 1, pagesize: 5 }],
  ['歌手列表', 'singer_list', { page: 1, pagesize: 5 }],
  // 需要真实 id（延迟填充）
  ['榜单歌曲', 'rank_audio', null],
  ['专辑歌曲', 'album_songs', null],
  ['歌手单曲', 'artist_audios', null],
  ['歌单歌曲', 'playlist_track_all', null],
  // 需要登录
  ['我的歌单', 'user_playlist', { page: 1, pagesize: 5 }],
  ['我的信息', 'user_detail', {}],
  ['最近播放', 'user_history', { page: 1, pagesize: 5 }],
  ['VIP信息', 'user_vip_detail', {}],
  ['云盘', 'user_cloud', { page: 1, pagesize: 5 }],
];

/** 把延迟填充的 null 参数换成真实 id */
function resolveParams(name, ctx) {
  switch (name) {
    case 'rank_audio':
      return { rankid: ctx.rankId, page: 1, pagesize: 5 };
    case 'album_songs':
      return { album_id: ctx.albumId, page: 1, pagesize: 5 };
    case 'artist_audios':
      return { id: ctx.authorId, page: 1, pagesize: 5 };
    case 'playlist_track_all':
      return { id: ctx.playlistId, page: 1, pagesize: 5 };
    default:
      return {};
  }
}

(async () => {
  // ---- 先解析出一批真实 id，否则测依赖 id 的接口只会拿到「参数错误」 ----
  console.log('解析真实 id …');
  const ctx = { rankId: 8888, playlistId: '', albumId: 0, audioId: 0, hash: '', authorId: 0 };

  try {
    const r = await client.call('rank_list', {});
    const info = (r.body && r.body.data && r.body.data.info) || [];
    const withId = info.find((x) => x.rankid && x.songinfo && x.songinfo.length);
    if (withId) ctx.rankId = withId.rankid;
    console.log(`  rankId     = ${ctx.rankId}`);
  } catch { /* 用默认值 */ }

  try {
    const t = await client.call('top_song', { page: 1, pagesize: 5 });
    const s = (t.body.data || [])[0];
    if (s) {
      ctx.albumId = s.album_id || 0;
      ctx.audioId = s.album_audio_id || s.audio_id || 0;
      ctx.hash = s.hash || '';
      console.log(`  song       = ${s.songname}  albumId=${ctx.albumId}  audioId=${ctx.audioId}`);
    }
  } catch { /* ignore */ }

  try {
    const p = await client.call('top_playlist', { page: 1, pagesize: 5 });
    const list = (p.body.data && (p.body.data.list || p.body.data.info || p.body.data.lists)) || [];
    const pl = list.find((x) => x.global_collection_id || x.specialid || x.id);
    if (pl) ctx.playlistId = pl.global_collection_id || pl.specialid || pl.id;
    console.log(`  歌单 id    = ${ctx.playlistId} (候选字段: ${list[0] ? Object.keys(list[0]).slice(0, 8).join(',') : '无'})`);
  } catch { /* ignore */ }

  try {
    const a = await client.call('singer_list', { page: 1, pagesize: 5 });
    const list = (a.body.data && a.body.data.info) || [];
    if (list[0]) ctx.authorId = list[0].author_id || list[0].singerid || 0;
    console.log(`  歌手 id    = ${ctx.authorId}`);
  } catch { /* ignore */ }

  console.log('');

  const rows = [];

  for (const [label, name, rawParams] of CASES) {
    const params = rawParams === null ? resolveParams(name, ctx) : rawParams;
    let cell;
    try {
      const res = await client.call(name, params);
      const j = judge(res);
      cell = j.ok ? `✅ ${j.why}` : `❌ ${j.why}`;
    } catch (e) {
      const b = e && e.body;
      if (b && typeof b === 'object') {
        const code = b.error_code ?? b.errcode;
        cell = `❌ error_code=${code} ${b.error_msg || b.error || ''}`.trim();
      } else {
        cell = `❌ ${(e && e.message) || 'unknown'}`;
      }
    }
    rows.push([label, name, cell]);
    console.log(`${label.padEnd(12, '　')} ${name.padEnd(24)} ${cell}`);
  }

  const okCount = rows.filter((r) => r[2].startsWith('✅')).length;
  console.log(`\n可用: ${okCount} / ${rows.length}`);
  console.log('\n失效的接口:');
  rows.filter((r) => !r[2].startsWith('✅')).forEach((r) => console.log(`  · ${r[0]} (${r[1]}) → ${r[2]}`));
})();
