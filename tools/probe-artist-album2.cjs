/*
 * 探针二：直接用 core 客户端调 vendor 里那几个现成的模块。
 *
 * 第一版我试的是 mobilecdn.kugou.com 的老接口 —— 全部 TLS 证书不匹配，
 * 那个域名已经不指向酷狗了。教训：**先看项目里 vendored 的参考实现
 * 有没有现成的，再自己去猜外部接口**（这个错今晚犯过好几次了）。
 *
 * 模块参数是 { id, page, pagesize }（不是 artistid/albumid），
 * 走 encryptType:'android'，由客户端统一签名并注入 cookie。
 */
const path = require('node:path');
const { KuGouClient } = require(path.join(__dirname, '..', 'packages', 'core', 'src', 'index.js'));
const { FileSessionStore } = require(path.join(__dirname, '..', 'packages', 'core', 'src', 'session-store.js'));

const SESSION = process.env.MUSIC_SESSION_FILE || path.join(__dirname, '..', 'packages', 'core', '.session.json');

const pickData = (res) => (res && res.body && (res.body.data || res.body)) || null;

async function main() {
  const store = new FileSessionStore(SESSION);
  const saved = store.load();
  const client = new KuGouClient({ device: saved.device, session: saved.session });

  const res = await client.search('周杰伦 晴天', { page: 1, pagesize: 5 });
  const song = (res.songs || [])[0];
  if (!song) {
    console.log('搜索没结果');
    return;
  }
  const artistId = Array.isArray(song.artistId) ? song.artistId[0] : song.artistId;
  const albumId = song.albumId;
  console.log('样例:', song.name, '| artist=', song.artist, '| artistId=', artistId, '| albumId=', albumId);

  const show = (label, data, keys) => {
    if (!data) {
      console.log(`[${label}] 没数据`);
      return;
    }
    console.log(`[${label}] 字段: ${Object.keys(data).slice(0, 18).join(',')}`);
    for (const k of keys) {
      const v = data[k];
      if (v !== undefined) console.log(`   ${k} = ${typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : v}`);
    }
  };

  try {
    const r = await client.call('artist_detail', { id: artistId });
    const d = pickData(r);
    show('歌手详情', d, ['author_name', 'author_id', 'sizable_cover', 'pic', 'intro', 'fans_counts', 'audio_total']);
  } catch (e) {
    console.log('[歌手详情] 失败:', e.message);
  }

  try {
    const r = await client.call('artist_audios', { id: artistId, page: 1, pagesize: 5 });
    const d = pickData(r);
    const list = (d && (d.audio_list || d.songs || d.list || d.info)) || [];
    console.log('[歌手歌曲] 条数 =', Array.isArray(list) ? list.length : '(不是数组)');
    if (Array.isArray(list) && list[0]) {
      console.log('   单条字段:', Object.keys(list[0]).slice(0, 20).join(','));
      console.log('   第一首:', list[0].audio_name || list[0].songname || list[0].name, '| hash:', list[0].hash || list[0].FileHash);
    }
  } catch (e) {
    console.log('[歌手歌曲] 失败:', e.message);
  }

  try {
    const r = await client.call('album_detail', { id: albumId });
    const d = pickData(r);
    show('专辑详情', d, ['album_name', 'album_id', 'publish_date', 'sizable_cover', 'author_name', 'intro', 'songcount']);
  } catch (e) {
    console.log('[专辑详情] 失败:', e.message);
  }

  try {
    const r = await client.call('album_songs', { id: albumId, page: 1, pagesize: 5 });
    const d = pickData(r);
    const list = (d && (d.songs || d.audio_list || d.list || d.info)) || [];
    console.log('[专辑歌曲] 条数 =', Array.isArray(list) ? list.length : '(不是数组)');
    if (Array.isArray(list) && list[0]) {
      console.log('   单条字段:', Object.keys(list[0]).slice(0, 20).join(','));
    }
  } catch (e) {
    console.log('[专辑歌曲] 失败:', e.message);
  }
}

main().catch((e) => console.error('探针异常:', e));
