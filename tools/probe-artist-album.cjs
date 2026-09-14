/*
 * 探针：验证"歌手详情 / 歌手歌曲 / 专辑详情 / 专辑歌曲"这四个端点到底能不能用。
 *
 * 为什么先探再写：这四个端点是**移动端 CDN**的公开接口
 * （mobilecdn.kugou.com/api/v3/...），免签名。但"我知道有这么个接口"
 * 和"它现在还能用、返回我期待的字段"是两件事 —— 这一晚我已经栽过好几次
 * "凭印象以为存在"。先跑一遍，确认字段名和结构，再动 UI。
 */
const path = require('node:path');
const { KuGouClient } = require(path.join(__dirname, '..', 'packages', 'core', 'src', 'index.js'));
const { FileSessionStore } = require(path.join(__dirname, '..', 'packages', 'core', 'src', 'session-store.js'));

const SESSION = process.env.MUSIC_SESSION_FILE || path.join(__dirname, '..', 'packages', 'core', '.session.json');

async function main() {
  const store = new FileSessionStore(SESSION);
  const saved = store.load();
  const client = new KuGouClient({ device: saved.device, session: saved.session });
  console.log('登录态:', client.isLoggedIn ? '已登录' : '未登录');

  // 先搜一首歌，拿到真实的 SingerId / AlbumID
  const res = await client.search('周杰伦 晴天', { page: 1, pagesize: 5 });
  // searchSongs 返回的是 { songs: [...] }，且已经归一化成 camelCase
  const list = res.songs || [];
  if (!list.length) {
    console.log('搜索没结果，无法继续');
    return;
  }
  const d = list[0];
  const singerId = d.artistId;
  const albumId = d.albumId;
  console.log('样例歌曲:', d.name, '| artist =', d.artist, '| artistId =', singerId, '| albumId =', albumId);

  const UA = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    Referer: 'https://m.kugou.com/',
  };

  const probe = async (label, url) => {
    try {
      const r = await fetch(url, { headers: UA });
      const text = await r.text();
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {
        console.log(`[${label}] 非 JSON，前 120 字：${text.slice(0, 120)}`);
        return null;
      }
      console.log(`[${label}] HTTP ${r.status}  status=${j.status}  error_code=${j.error_code}`);
      return j;
    } catch (e) {
      // cause 也要打出来 —— 只报 "fetch failed" 等于什么都没说
      const cause = e.cause && (e.cause.message || e.cause.code || String(e.cause));
      console.log(`[${label}] 请求失败：${e.message}  cause=${cause}`);
      return null;
    }
  };

  if (singerId) {
    const info = await probe('歌手信息', `https://mobilecdn.kugou.com/api/v3/artist/info?artistid=${singerId}`);
    if (info && info.data) {
      console.log('  歌手字段:', Object.keys(info.data).join(','));
      console.log('  名字:', info.data.artistname || info.data.name, '| 歌曲数:', info.data.songcount, '| 图:', (info.data.imgurl || '').slice(0, 60));
    }
    const songs = await probe('歌手歌曲', `https://mobilecdn.kugou.com/api/v3/artist/songs?artistid=${singerId}&page=1&pagesize=5`);
    if (songs && songs.data && songs.data.info) {
      console.log('  返回条数:', songs.data.info.length, '| total:', songs.data.total);
      console.log('  单条字段:', Object.keys(songs.data.info[0]).join(','));
    }
  }

  if (albumId) {
    const ainfo = await probe('专辑信息', `https://mobilecdn.kugou.com/api/v3/album/info?albumid=${albumId}`);
    if (ainfo && ainfo.data) {
      console.log('  专辑字段:', Object.keys(ainfo.data).join(','));
      console.log('  名字:', ainfo.data.albumname, '| 歌手:', ainfo.data.author_name, '| 图:', (ainfo.data.imgurl || '').slice(0, 60));
    }
    const asongs = await probe('专辑歌曲', `https://mobilecdn.kugou.com/api/v3/album/song?albumid=${albumId}&page=1&pagesize=5`);
    if (asongs && asongs.data && asongs.data.info) {
      console.log('  返回条数:', asongs.data.info.length, '| total:', asongs.data.total);
      console.log('  单条字段:', Object.keys(asongs.data.info[0]).join(','));
    }
  }
}

main().catch((e) => console.error('探针异常:', e));
