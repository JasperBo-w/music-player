'use strict';

/**
 * 扫码登录
 *
 * 流程：login/qr/key → login/qr/create → 轮询 login/qr/check
 * 状态：0 过期 / 1 等待扫码 / 2 待确认 / 4 授权成功
 *
 * 登录成功后把 session 落盘，后续脚本用 loadClient() 复用。
 *
 * 运行：node packages/core/scripts/login-qr.js
 * 二维码会存成 login-qr.png，用酷狗 App 扫它。
 */

const fs = require('node:fs');
const path = require('node:path');
const { KuGouClient } = require('../src/index.js');
const { FileSessionStore } = require('../src/session-store.js');

const STORE_PATH = path.join(__dirname, '..', '.session.json');
const QR_PNG = path.join(__dirname, '..', '..', '..', 'login-qr.png');

const store = new FileSessionStore(STORE_PATH);
const saved = store.load();

const client = new KuGouClient({
  device: saved.device,
  session: saved.session,
  onSessionChange: (session) => store.save({ device: client.device, session }),
});

const STATUS_TEXT = {
  0: '二维码已过期',
  1: '等待扫码…',
  2: '已扫码，请在手机上确认',
  4: '授权成功',
};

(async () => {
  if (client.isLoggedIn) {
    console.log(`已有登录态 (userid=${client.session.userid})，先验证是否仍然有效…`);
    try {
      const info = await client.call('user_detail');
      const d = info.body && info.body.data;
      if (d) {
        console.log(`✅ 登录态有效：${d.nickname || d.username || '(无昵称)'}`);
        console.log(JSON.stringify(d).slice(0, 600));
        return;
      }
    } catch (e) {
      console.log(`登录态已失效 (${(e && e.body && (e.body.error_code || e.body.errcode)) || e.message})，重新扫码`);
    }
  }

  // ---------- 1. 取 key ----------
  console.log('\n[1/3] 申请二维码 key …');
  const keyRes = await client.loginQrKey();
  const key = keyRes.body && keyRes.body.data && keyRes.body.data.qrcode;
  if (!key) {
    console.error('拿不到 key，响应：', JSON.stringify(keyRes.body).slice(0, 500));
    process.exit(1);
  }
  console.log(`      key = ${key}`);

  // ---------- 2. 生成二维码 ----------
  console.log('\n[2/3] 生成二维码 …');
  const createRes = await client.loginQrCreate(key, true);
  const data = createRes.body && createRes.body.data;
  if (!data) {
    console.error('二维码生成失败：', JSON.stringify(createRes.body).slice(0, 500));
    process.exit(1);
  }

  console.log(`      扫码链接: ${data.url}`);

  if (data.base64) {
    const b64 = String(data.base64).replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(QR_PNG, Buffer.from(b64, 'base64'));
    console.log(`\n  ╔══════════════════════════════════════════════════════════╗`);
    console.log(`  ║  二维码已存到:                                            ║`);
    console.log(`  ║  ${QR_PNG}`);
    console.log(`  ║  用酷狗 App 扫它即可登录                                   ║`);
    console.log(`  ╚══════════════════════════════════════════════════════════╝\n`);
  }

  // ---------- 3. 轮询 ----------
  console.log('[3/3] 等待扫码（最多 3 分钟）…');
  const deadline = Date.now() + 180000;
  let last = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));

    let res;
    try {
      res = await client.loginQrCheck(key);
    } catch (e) {
      const b = e && e.body;
      console.log(`      轮询异常: error_code=${b && (b.error_code || b.errcode)} ${(b && (b.error_msg || b.error)) || ''}`);
      continue;
    }

    const d = res.body && res.body.data;
    const status = d && d.status;

    if (status !== last) {
      console.log(`      状态 ${status} → ${STATUS_TEXT[status] || '未知'}`);
      last = status;
    }

    if (status === 4) {
      console.log('\n✅ 登录成功！');
      store.save({ device: client.device, session: client.session });
      console.log(`     会话已保存到 ${STORE_PATH}`);
      console.log(`     token  = ${String(client.session.token).slice(0, 16)}…`);
      console.log(`     userid = ${client.session.userid}`);

      // 立刻验证登录态能不能拿到用户数据
      console.log('\n验证：拉取账号信息');
      try {
        const info = await client.call('user_detail');
        const u = info.body && info.body.data;
        console.log(`     ${u ? `昵称=${u.nickname}  VIP类型=${u.vip_type ?? '?'}  ${JSON.stringify(u).slice(0, 300)}` : JSON.stringify(info.body).slice(0, 300)}`);
      } catch (e) {
        console.log(`     失败: ${JSON.stringify(e && e.body).slice(0, 300)}`);
      }

      console.log('\n验证：拉取我的歌单');
      try {
        const pl = await client.getUserPlaylists({ page: 1, pagesize: 30 });
        const info = pl.body && pl.body.data && (pl.body.data.info || pl.body.data.list);
        if (Array.isArray(info)) {
          console.log(`     ✅ 拿到 ${info.length} 个歌单:`);
          info.slice(0, 12).forEach((p, i) => {
            console.log(`        [${i}] ${p.name || p.list_create_list_name || p.specialname}  (${p.song_count || p.songcount || '?'} 首)`);
          });
        } else {
          console.log(`     ${JSON.stringify(pl.body).slice(0, 400)}`);
        }
      } catch (e) {
        console.log(`     失败: ${JSON.stringify(e && e.body).slice(0, 300)}`);
      }

      console.log('\n验证：登录后再试搜索接口（之前报 152）');
      try {
        const s = await client.search('周杰伦', { page: 1, pagesize: 5 });
        const lists = s.body && s.body.data && s.body.data.lists;
        console.log(`     搜索返回 ${Array.isArray(lists) ? lists.length : 0} 条`);
      } catch (e) {
        const b = e && e.body;
        console.log(`     仍然失败: error_code=${b && (b.error_code || b.errcode)} ${(b && (b.error_msg || b.error)) || e.message}`);
      }

      return;
    }

    if (status === 0) {
      console.log('      二维码过期，请重新运行本脚本');
      return;
    }
  }

  console.log('\n超时，未完成扫码');
})();
