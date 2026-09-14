'use strict';

/**
 * 搜索接口 Parameter Error(152) 诊断脚本
 *
 * 思路：既然签名被接受了（能拿到业务错误码而非签名错误），
 * 那问题在参数本身。逐个变量排除：
 *   A. dfid 用原项目的默认值 '-'
 *   B. dfid 用随机值
 *   C. 先 register_dev 拿真实 dfid 再搜
 *   D. 换 search_complex / search_mixed 接口对比
 * 同时把真正发出去的 URL 和关键 header 打出来。
 */

const axios = require('axios');
const { createRequest } = require('../src/kugou/vendor/util/request');
const searchModule = require('../src/kugou/vendor/module/search.js');
const complexModule = require('../src/kugou/vendor/module/search_complex.js');
const registerDev = require('../src/kugou/vendor/module/register_dev.js');
const { normalizeDeviceIdentity } = require('../src/device.js');

const device = normalizeDeviceIdentity(null);
console.log('设备身份:', JSON.stringify(device, null, 2));

// 拦截 axios，打印真实发出的请求
const origAxios = axios;
let lastRequest = null;
axios.interceptors = axios.interceptors || {};

function logRequest(config) {
  lastRequest = config;
  const url = config.url || '';
  console.log(`\n  >>> ${String(config.method).toUpperCase()} ${config.baseURL || ''}${url}`);
  console.log(`      params: ${JSON.stringify(config.params)}`);
  console.log(`      headers: ${JSON.stringify(config.headers)}`);
  if (config.data) console.log(`      data: ${String(config.data).slice(0, 200)}`);
  return config;
}

// createRequest 内部直接调用 axios(...)，用 axios 的 request 拦截器抓包
axios.interceptors.request.use(logRequest);

async function trySearch(label, cookie, mod = searchModule) {
  console.log(`\n${'-'.repeat(64)}\n[${label}]`);
  try {
    const res = await mod(
      { keywords: '周杰伦', page: 1, pagesize: 30, cookie },
      (config) => createRequest(Object.assign({}, config, { cookie: Object.assign({}, cookie, config.cookie || {}) }))
    );
    const d = res.body && res.body.data;
    console.log(`  结果: status=${res.status} total=${d && d.total} lists=${d && d.lists ? d.lists.length : 0}`);
    if (d && d.lists && d.lists[0]) {
      console.log(`  第一首: ${d.lists[0].SongName} — ${d.lists[0].SingerName}`);
    }
    if (res.body && res.body.error_code) {
      console.log(`  error_code=${res.body.error_code} error_msg=${res.body.error_msg}`);
    }
    return res;
  } catch (e) {
    const body = e && e.body ? e.body : e;
    console.log(`  失败: status=${e && e.status} body=${JSON.stringify(body).slice(0, 400)}`);
    return null;
  }
}

(async () => {
  // A. 原项目的默认 dfid
  await trySearch('A. dfid = "-"（原项目默认）', Object.assign({}, device, { dfid: '-' }));

  // B. 随机 dfid
  await trySearch('B. dfid = 随机值', device);

  // C. 不带 dfid
  const noDfid = Object.assign({}, device);
  delete noDfid.dfid;
  await trySearch('C. 完全不传 dfid', noDfid);

  // D. 别的搜索接口
  await trySearch('D. search_complex 接口', Object.assign({}, device, { dfid: '-' }), complexModule);

  // E. 先注册设备拿真实 dfid
  console.log(`\n${'-'.repeat(64)}\n[E. register_dev 注册设备]`);
  try {
    const reg = await registerDev(
      { cookie: Object.assign({}, device, { dfid: '-' }) },
      (config) => createRequest(Object.assign({}, config, { cookie: Object.assign({}, device, { dfid: '-' }, config.cookie || {}) }))
    );
    console.log(`  status=${reg.status}`);
    console.log(`  cookie: ${JSON.stringify(reg.cookie)}`);
    console.log(`  body: ${JSON.stringify(reg.body).slice(0, 600)}`);

    const realDfid = (reg.cookie || [])
      .map((c) => /(?:^|;\s*)dfid=([^;]+)/.exec(c))
      .filter(Boolean)
      .map((m) => m[1])[0];

    if (realDfid) {
      console.log(`\n  拿到真实 dfid = ${realDfid}，用它重试搜索：`);
      await trySearch('E2. 真实 dfid + 搜索', Object.assign({}, device, { dfid: realDfid }));
    }
  } catch (e) {
    console.log(`  register_dev 失败: ${e && e.message}`);
    if (e && e.body) console.log(`  body: ${JSON.stringify(e.body).slice(0, 500)}`);
  }
})();
