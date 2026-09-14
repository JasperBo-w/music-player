'use strict';

/**
 * 验证收藏（喜欢）能力
 *
 * 只读验证：找「我喜欢」歌单、拉全量已喜欢 hash 集合、确认能命中。
 * 实际的加/删操作留给界面上的按钮，避免动到你的账号数据。
 */

const path = require('node:path');
const { KuGouClient } = require('../src/index.js');
const { FileSessionStore } = require('../src/session-store.js');

const store = new FileSessionStore(path.join(__dirname, '..', '.session.json'));
const saved = store.load();

if (!saved.session || !saved.session.token) {
  console.error('没有登录态，请先运行 node scripts/login-qr.js');
  process.exit(1);
}

const client = new KuGouClient({ device: saved.device, session: saved.session });

(async () => {
  console.log('=== 1. 定位「我喜欢」歌单 ===');
  const t0 = Date.now();
  const listid = await client.getFavoriteListId();
  console.log(`  list_create_listid = ${listid}   （用时 ${Date.now() - t0}ms）`);
  console.log(`  global_collection_id = ${client._favGid}`);

  console.log('\n=== 2. 拉全量已喜欢 hash ===');
  const t1 = Date.now();
  const set = await client.getFavoriteHashes();
  console.log(`  共 ${set.size} 首   用时 ${Date.now() - t1}ms`);

  if (set.size === 0) {
    console.log('  ⚠️ 集合是空的，可能接口返回结构变了');
    return;
  }

  console.log('\n=== 3. 命中测试 ===');
  const sample = [...set][0];
  console.log(`  样例 hash = ${sample}`);
  console.log(`  在集合中: ${client._favHashes.has(sample)}`);

  console.log('\n=== 4. 反查 fileid（取消喜欢时要用的条目号）===');
  const t2 = Date.now();
  const fileId = await client.findFavoriteFileId(sample);
  console.log(`  fileid = ${fileId}   用时 ${Date.now() - t2}ms`);

  console.log('\n=== 5. 缓存是否生效（第二次应该秒回）===');
  const t3 = Date.now();
  await client.getFavoriteHashes();
  console.log(`  第二次用时 ${Date.now() - t3}ms （应远小于第一次）`);

  const ok = set.size > 0 && fileId !== null;
  console.log(`\n${ok ? '✅ 收藏能力验证通过' : '❌ 验证未通过'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('\n[失败]', e && e.message ? e.message : e);
  if (e && e.body) console.error(JSON.stringify(e.body).slice(0, 400));
  process.exit(1);
});
