/*
 * 直接打酷狗公开搜索端点的原始返回。
 *
 * 为什么要绕过 core：core 的 searchSongs 已经把它整理成歌曲对象了，
 * 用户反馈"歌名和歌对不上、混进解说小说"，得看**原始字段**才知道是
 *   ① 接口本身混了别的类型（听书/长音频），还是
 *   ② 我们取错了字段名。
 * 参数完全照抄 web-api.js 里的 searchSongs，唯一区别是不做归一化。
 */
const https = require('node:https');

const keyword = process.argv[2] || '周杰伦';

const url =
  'https://songsearch.kugou.com/song_search_v2?' +
  new URLSearchParams({
    keyword,
    page: '1',
    pagesize: '12',
    userid: '-1',
    clientver: '2000',
    platform: 'WebFilter',
    tag: 'em',
    filter: '2',
    iscorrection: '1',
    privilege_filter: '0',
    filter_ver: '2',
    appid: '1014',
    token: '',
    mid: '0'.repeat(32),
  }).toString();

https
  .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      let j;
      try {
        j = JSON.parse(body);
      } catch (e) {
        console.log('不是 JSON:', body.slice(0, 300));
        return;
      }
      const lists = (j.data && j.data.lists) || [];
      console.log('total =', j.data && j.data.total, ' 本页条数 =', lists.length);
      console.log('--- 前 6 条的原始关键字段 ---');
      lists.slice(0, 12).forEach((it, i) => {
        console.log(
          JSON.stringify({
            i,
            dur: it.Duration,
            Type: it.Type,
            SongName: it.SongName,
            SingerName: it.SingerName,
            FileHash: String(it.FileHash || '').slice(0, 8),
            Audioid: it.Audioid,
            MixSongID: it.MixSongID,
            AlbumID: it.AlbumID,
            Duration: it.Duration,
            /* 这几个字段最可能藏着"听书/长音频"的身份标记 */
            AudioType: it.AudioType,
            PublishType: it.PublishType,
            IsLongAudio: it.IsLongAudio,
            LongAudio: it.LongAudio,
            Type: it.Type,
            MediaType: it.MediaType,
            ResType: it.ResType,
            Privilege: it.Privilege,
            FolderType: it.FolderType,
            Source: it.Source,
          })
        );
      });
      console.log('\n--- 第一条的全部字段名 ---');
      console.log(lists[0] ? Object.keys(lists[0]).join(',') : '(空)');
    });
  })
  .on('error', (e) => console.log('请求失败:', e.message));
