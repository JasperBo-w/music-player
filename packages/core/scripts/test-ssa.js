'use strict';

/**
 * 验证 SSA 重试能否拿到播放地址
 *
 * 现象：song_url 返回 errcode=20028「本次请求需要验证」，同时带 ssa-code 响应头。
 * 上游 request.js 只是把本地生成的 sid/edt 挂到 body 上，并没有重试。
 *
 * 假设：酷狗要求客户端带 sid + edt 重新请求一次。
 * 本脚本验证这个假设，并试几种参数组合。
 */

const https = require('node:https');
const { KuGouClient } = require('../src/index.js');
const { createRequest } = require('../src/kugou/vendor/util/request');
const { generateSimulate } = require('../src/kugou/vendor/util/generate_simulate');
const { normalizeDeviceIdentity } = require('../src/device.js');

const client = new KuGouClient();
const device = client.device;

function head(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { Range: 'bytes=0-2047', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let got = 0;
      res.on('data', (c) => (got += c.length));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], bytes: got }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

/** 直接调用 song_url 模块，可附加额外参数 */
function rawSongUrl(extra, extraHeaders) {
  const cookie = Object.assign({}, device, { dfid: '-' });
  const songUrlModule = require('../src/kugou/vendor/module/song_url.js');
  return songUrlModule(
    Object.assign({ album_id: 0, album_audio_id: 0, quality: 128, cookie }, extra),
    (config) =>
      createRequest(
        Object.assign({}, config, {
          cookie: Object.assign({}, cookie, config.cookie || {}),
          headers: Object.assign({}, config.headers, extraHeaders || {}),
        })
      )
  );
}

(async () => {
  // 拿一首免费歌
  const top = await client.call('top_song', { page: 1, pagesize: 30 });
  const song = (top.body.data || []).find((s) => Number(s.pay_type) === 0 && Number(s.privilege_128) === 0)
    || top.body.data[0];

  const base = {
    hash: song.hash,
    album_id: song.album_id || 0,
    album_audio_id: song.album_audio_id || song.audio_id || 0,
  };
  console.log(`测试歌曲: ${song.songname}  hash=${String(song.hash).slice(0, 12)}…`);
  console.log(`pay_type=${song.pay_type} privilege_128=${song.privilege_128}`);

  // ---------- 第 1 步：原始请求，看 ssa-code 头 ----------
  console.log('\n' + '='.repeat(70));
  console.log('第 1 步：原始请求，抓 ssa-code 响应头');
  console.log('='.repeat(70));

  let ssaCode = null;
  let firstBody = null;
  {
    const cookie = Object.assign({}, device, { dfid: '-' });
    const songUrlModule = require('../src/kugou/vendor/module/song_url.js');
    await songUrlModule(
      Object.assign({}, base, { cookie }),
      async (config) => {
        const res = await createRequest(Object.assign({}, config, { cookie }));
        const h = res.headers || {};
        ssaCode = h['ssa-code'] || h['SSA-CODE'];
        firstBody = res.body;
        console.log(`  响应头 keys: ${JSON.stringify(Object.keys(h))}`);
        console.log(`  ssa-code = ${ssaCode}`);
        console.log(`  body = ${JSON.stringify(res.body).slice(0, 300)}`);
        return res;
      }
    ).catch((e) => {
      const h = (e && e.headers) || {};
      ssaCode = h['ssa-code'] || h['SSA-CODE'];
      firstBody = e && e.body;
      console.log(`  抛出异常, headers=${JSON.stringify(h)}`);
      console.log(`  body = ${JSON.stringify(firstBody).slice(0, 300)}`);
    });
  }

  // ---------- 第 2 步：带 sid/edt 重试 ----------
  console.log('\n' + '='.repeat(70));
  console.log('第 2 步：带 sid / edt 重试');
  console.log('='.repeat(70));

  const sim = generateSimulate(device.KUGOU_API_MID, 0, '-', device.KUGOU_API_WEBGL);
  console.log(`  本地生成 sid 长度=${(sim.sid || '').length}  edt 长度=${(sim.edt || '').length}`);

  const VARIANTES = [
    ['sid+edt 一起传', { sid: sim.sid, edt: sim.edt }],
    ['只传 edt', { edt: sim.edt }],
    ['只传 sid', { sid: sim.sid }],
    ['复用服务端返回的 sid/edt', {
      sid: firstBody && firstBody.sid,
      edt: firstBody && firstBody.edt,
    }],
  ];

  for (const [label, extra] of VARIANTES) {
    if (!extra.sid && !extra.edt) {
      console.log(`\n  [${label}] 跳过（服务端没返回可用值）`);
      continue;
    }
    try {
      const res = await rawSongUrl(Object.assign({}, base, extra));
      const item = Array.isArray(res.body) ? res.body[0] : res.body;
      if (item && item.url) {
        const probe = await head(item.url);
        console.log(`\n  [${label}] ✅✅ 拿到地址! br=${item.br} 实测 HTTP ${probe.status} ${probe.type} ${probe.bytes}B`);
        console.log(`      ${String(item.url).slice(0, 100)}…`);
      } else {
        console.log(`\n  [${label}] ❌ errcode=${item && item.errcode} error=${item && item.error} status=${item && item.status}`);
      }
    } catch (e) {
      const b = e && e.body ? e.body : e;
      console.log(`\n  [${label}] ❌ 异常 errcode=${b && b.errcode} error=${b && b.error}`);
    }
  }

  // ---------- 第 3 步：换请求头伪装 ----------
  console.log('\n' + '='.repeat(70));
  console.log('第 3 步：换 User-Agent 伪装（试试是否是 UA 风控）');
  console.log('='.repeat(70));

  const UAS = [
    ['酷狗 H5', 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'],
    ['酷狗 PC 客户端 UA', 'KuGou2012-9020-1-0-1-1-1-1-1-1-1-1-1-1-1-1'],
    ['iOS 客户端', 'KuGou-iOS-11430'],
  ];
  for (const [label, ua] of UAS) {
    try {
      const res = await rawSongUrl(Object.assign({}, base, { sid: sim.sid, edt: sim.edt }), { 'User-Agent': ua });
      const item = Array.isArray(res.body) ? res.body[0] : res.body;
      console.log(`  [${label}] ${item && item.url ? '✅ 有地址' : `❌ errcode=${item && item.errcode}`}`);
    } catch (e) {
      const b = e && e.body ? e.body : e;
      console.log(`  [${label}] ❌ errcode=${b && b.errcode}`);
    }
  }
})();
