'use strict';

/**
 * 原始响应转储：对比几个搜索接口的真实返回，找出哪个可用
 */

const { createRequest } = require('../src/kugou/vendor/util/request');
const { normalizeDeviceIdentity } = require('../src/device.js');

const device = normalizeDeviceIdentity(null);

const CANDIDATES = [
  ['search', require('../src/kugou/vendor/module/search.js'), { keywords: '周杰伦', page: 1, pagesize: 30 }],
  ['search_complex', require('../src/kugou/vendor/module/search_complex.js'), { keywords: '周杰伦', page: 1, pagesize: 30 }],
  ['search_mixed', require('../src/kugou/vendor/module/search_mixed.js'), { keywords: '周杰伦', page: 1, pagesize: 30 }],
  ['search_default', require('../src/kugou/vendor/module/search_default.js'), { keywords: '周杰伦', page: 1, pagesize: 30 }],
  ['search_suggest', require('../src/kugou/vendor/module/search_suggest.js'), { keywords: '周杰伦' }],
  ['top_song', require('../src/kugou/vendor/module/top_song.js'), { page: 1, pagesize: 5 }],
  ['rank_list', require('../src/kugou/vendor/module/rank_list.js'), {}],
];

const cookie = Object.assign({}, device, { dfid: '-' });

(async () => {
  for (const [name, mod, params] of CANDIDATES) {
    console.log('\n' + '#'.repeat(70));
    console.log(`# ${name}`);
    console.log('#'.repeat(70));
    try {
      const res = await mod(
        Object.assign({}, params, { cookie }),
        (config) => createRequest(Object.assign({}, config, { cookie: Object.assign({}, cookie, config.cookie || {}) }))
      );
      const raw = JSON.stringify(res.body);
      console.log(`status=${res.status}  body(${raw.length} bytes):`);
      console.log(raw.slice(0, 1500));
    } catch (e) {
      const body = e && e.body ? JSON.stringify(e.body) : String(e && e.message);
      console.log(`HTTP status=${e && e.status}  body:`);
      console.log(body.slice(0, 1200));
    }
  }
})();
