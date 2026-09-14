/*
 * 探针三：把四个接口的**真实结构**打出来。
 *
 * 上一轮已经确认它们都能返回数据，但字段路径我没猜对：
 *   歌手歌曲 → 0 条
 *   专辑详情 → 空
 *   专辑歌曲 → 是嵌套结构（base / audio_info / album_info / authors）
 *
 * 不再猜字段名了 —— 直接把第一层、第二层的键打出来，照着写映射。
 */
const path = require('node:path');
const { KuGouClient } = require(path.join(__dirname, '..', 'packages', 'core', 'src', 'index.js'));
const { FileSessionStore } = require(path.join(__dirname, '..', 'packages', 'core', 'src', 'session-store.js'));

const SESSION = process.env.MUSIC_SESSION_FILE || path.join(__dirname, '..', 'packages', 'core', '.session.json');

/** 打印一个值的骨架：对象给键，数组给长度+首元素骨架 */
function skeleton(v, depth = 0) {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) {
    return `Array(${v.length})` + (v.length ? ' [' + skeleton(v[0], depth + 1) + ']' : '');
  }
  if (typeof v === 'object') {
    if (depth > 1) return '{...}';
    return '{ ' + Object.keys(v).slice(0, 24).join(', ') + ' }';
  }
  return typeof v;
}

async function main() {
  const store = new FileSessionStore(SESSION);
  const saved = store.load();
  const client = new KuGouClient({ device: saved.device, session: saved.session });

  const res = await client.search('周杰伦 晴天', { page: 1, pagesize: 5 });
  const song = (res.songs || [])[0];
  const artistId = Array.isArray(song.artistId) ? song.artistId[0] : song.artistId;
  const albumId = song.albumId;

  const dump = async (label, name, params) => {
    console.log('\n===== ' + label + ' =====');
    try {
      const r = await client.call(name, params);
      const b = r && r.body;
      console.log('body 顶层:', skeleton(b));
      const d = b && (b.data !== undefined ? b.data : b);
      console.log('data:', skeleton(d));
      // 如果 data 是数组，看首元素
      if (Array.isArray(d) && d[0]) console.log('data[0]:', skeleton(d[0]));
      // 常见的列表字段
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        for (const k of ['info', 'list', 'songs', 'audio_list', 'lists', 'data']) {
          if (d[k] !== undefined) console.log(`  d.${k}:`, skeleton(d[k]));
        }
      }
    } catch (e) {
      console.log('失败:', e.message);
    }
  };

  await dump('歌手歌曲', 'artist_audios', { id: artistId, page: 1, pagesize: 5 });
  await dump('专辑详情', 'album_detail', { id: albumId });
  await dump('专辑歌曲', 'album_songs', { id: albumId, page: 1, pagesize: 5 });
}

main().catch((e) => console.error('异常:', e));
