'use strict';

/**
 * 验证 Mineradio 那套端点是否可用
 *
 * 我的核心走网关 v3/search/song 被 152 拒绝；Mineradio 走的是另一套
 * 公开 Web 端点，无需 signature。这里逐条实测：
 *   1. 搜索  songsearch.kugou.com/song_search_v2
 *   2. 播放  m.kugou.com/app/i/getSongInfo.php (移动端, key=md5(hash+'kgcloud'))
 *   3. 播放  wwwapi.kugou.com/play/songinfo (Web 端)
 *   4. 歌词  krcs.kugou.com/search + /download
 */

const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

const SEARCH_URL = 'https://songsearch.kugou.com/song_search_v2';
const PLAY_MOBILE = 'https://m.kugou.com/app/i/getSongInfo.php';
const PLAY_WEB = 'https://wwwapi.kugou.com/play/songinfo';
const LYRIC_SEARCH = 'https://krcs.kugou.com/search';
const LYRIC_DOWNLOAD = 'https://krcs.kugou.com/download';

const HEADERS = {
  Referer: 'https://www.kugou.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
const cloudKey = (hash) => md5(String(hash) + 'kgcloud');
const mid = md5(String(Date.now()) + Math.random());

function get(url, extraHeaders) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: Object.assign({}, HEADERS, extraHeaders || {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 保留原文 */ }
        resolve({ status: res.statusCode, text, json, type: res.headers['content-type'] });
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

const hr = (t) => console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70));

(async () => {
  // ---------- 1. 搜索 ----------
  hr('1. Web 搜索 songsearch.kugou.com/song_search_v2');
  const su = new URL(SEARCH_URL);
  su.searchParams.set('keyword', '周杰伦');
  su.searchParams.set('page', '1');
  su.searchParams.set('pagesize', '10');
  su.searchParams.set('userid', '-1');
  su.searchParams.set('clientver', '2000');
  su.searchParams.set('platform', 'WebFilter');
  su.searchParams.set('tag', 'em');
  su.searchParams.set('filter', '2');
  su.searchParams.set('iscorrection', '1');
  su.searchParams.set('privilege_filter', '0');
  su.searchParams.set('filter_ver', '2');
  su.searchParams.set('appid', '1014');
  su.searchParams.set('token', '');
  su.searchParams.set('mid', mid);

  const sres = await get(su.toString());
  if (sres.error) {
    console.log(`  ❌ ${sres.error}`);
  } else {
    console.log(`  HTTP ${sres.status}  ${sres.type}`);
    const lists = sres.json && sres.json.data && sres.json.data.lists;
    if (Array.isArray(lists)) {
      console.log(`  ✅ 搜索成功！返回 ${lists.length} 条`);
      lists.slice(0, 6).forEach((s, i) => {
        console.log(`     [${i}] ${s.SongName} — ${s.SingerName}  hash=${String(s.FileHash).slice(0, 12)}… album_id=${s.AlbumID} audio_id=${s.Audioid}`);
      });
    } else {
      console.log(`  ❌ 无 lists。原文前 400 字：\n${sres.text.slice(0, 400)}`);
    }
  }

  // 从搜索结果取一首用于播放测试
  const first = sres.json && sres.json.data && sres.json.data.lists && sres.json.data.lists[0];
  if (!first) { console.log('\n没有搜索结果，无法继续测播放'); return; }

  // ---------- 2. 移动端播放 ----------
  hr('2. 移动端播放 m.kugou.com/app/i/getSongInfo.php');
  const mu = new URL(PLAY_MOBILE);
  mu.searchParams.set('cmd', 'playInfo');
  mu.searchParams.set('hash', first.FileHash);
  mu.searchParams.set('key', cloudKey(first.FileHash));
  mu.searchParams.set('album_id', String(first.AlbumID || 0));
  mu.searchParams.set('pid', '1');
  mu.searchParams.set('forceDown', '0');
  mu.searchParams.set('vip', '65530');

  const mres = await get(mu.toString(), { Referer: 'https://m.kugou.com/' });
  if (mres.error) {
    console.log(`  ❌ ${mres.error}`);
  } else {
    console.log(`  HTTP ${mres.status}`);
    const j = mres.json;
    if (j && Number(j.status) === 1 && j.url) {
      console.log(`  ✅ 拿到播放地址！`);
      console.log(`     url      = ${String(j.url).slice(0, 100)}…`);
      console.log(`     fileName = ${j.fileName}`);
      console.log(`     bitRate  = ${j.bitRate}`);
      console.log(`     timeLength = ${j.timeLength}`);
      const probe = await get(j.url.startsWith('https') ? j.url : j.url, { Range: 'bytes=0-2047' });
      console.log(`     实测拉流: ${probe.error ? probe.error : `HTTP ${probe.status} ${probe.type}`}`);
    } else {
      console.log(`  ❌ status=${j && j.status} error=${j && (j.error || j.err)}`);
      console.log(`     原文前 400 字：${mres.text.slice(0, 400)}`);
    }
  }

  // ---------- 3. Web 端播放 ----------
  hr('3. Web 播放 wwwapi.kugou.com/play/songinfo');
  const wu = new URL(PLAY_WEB);
  wu.searchParams.set('hash', first.FileHash);
  wu.searchParams.set('album_id', String(first.AlbumID || 0));
  wu.searchParams.set('platid', '4');
  wu.searchParams.set('mid', mid);
  const wres = await get(wu.toString());
  if (wres.error) {
    console.log(`  ❌ ${wres.error}`);
  } else {
    const j = wres.json;
    console.log(`  HTTP ${wres.status}  status=${j && j.status}`);
    if (j && j.data && (j.data.play_url || j.data.url)) {
      console.log(`  ✅ 拿到播放地址: ${String(j.data.play_url || j.data.url).slice(0, 100)}…`);
    } else {
      console.log(`  ❌ 原文前 300 字：${wres.text.slice(0, 300)}`);
    }
  }

  // ---------- 4. 歌词 ----------
  hr('4. 歌词 krcs.kugou.com/search + /download');
  const lu = new URL(LYRIC_SEARCH);
  lu.searchParams.set('ver', '1');
  lu.searchParams.set('man', 'yes');
  lu.searchParams.set('client', 'mobi');
  lu.searchParams.set('keyword', `${first.SongName} - ${first.SingerName}`);
  lu.searchParams.set('hash', first.FileHash);

  const lres = await get(lu.toString());
  const cand = lres.json && lres.json.candidates && lres.json.candidates[0];
  if (cand) {
    console.log(`  ✅ 歌词候选: id=${cand.id} accesskey=${String(cand.accesskey).slice(0, 12)}… song=${cand.song}`);

    const du = new URL(LYRIC_DOWNLOAD);
    du.searchParams.set('ver', '1');
    du.searchParams.set('client', 'pc');
    du.searchParams.set('id', cand.id);
    du.searchParams.set('accesskey', cand.accesskey);
    du.searchParams.set('fmt', 'krc');
    du.searchParams.set('charset', 'utf8');
    const dres = await get(du.toString());
    const content = dres.json && dres.json.content;
    if (content) {
      console.log(`  ✅ 歌词下载成功，base64 长度 ${content.length}`);
      const buf = Buffer.from(content, 'base64');
      const head = buf.subarray(0, 4).toString('hex');
      console.log(`     解码后前 4 字节 = ${head}（KRC 格式头）`);
    } else {
      console.log(`  ❌ 下载失败: ${dres.text ? dres.text.slice(0, 300) : dres.error}`);
    }
  } else {
    console.log(`  ❌ 无候选: ${lres.text ? lres.text.slice(0, 300) : lres.error}`);
  }
})();
