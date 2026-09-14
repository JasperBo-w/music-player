/*
 * 退出登录（第二版）。
 *
 * 第一版三个地方都失败了，原因各不相同，都记下来：
 *
 * ① **文件是 CRLF，我的匹配串用 \n 写的** —— 永远匹配不上。
 *    这个文件我改过很多次，一开始是 CRLF；用 readFileSync 读出来带 \r，
 *    而我在补丁里手写的多行字符串只有 \n。所以"按内容匹配"必须先归一化行尾。
 *
 * ② IPC 的名字不是 'account:xxx'，而是**通用的 'account' 加一个 wrap(...)**
 *    （main.js:337）。我没先看清楚就假设命名规则，锚点自然找不到。
 *    → 所以这次挂到 wrap 那套里，而不是自己另起一个 handler。
 *
 * ③ **askConfirm 的确定按钮写死是"删除"**（main.js:1273），
 *    拿它做"退出登录"会弹出一个写着"删除"的按钮。
 *    而且它是回调式 (title, message, onOk)、不返回 Promise ——
 *    我第一版写的 `await askConfirm(...)` 拿到的是 undefined，点了也没反应。
 *    → 所以这里直接用 mpModal 自己搭一个确认框，按钮文案才可控。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const log = (m) => console.log(m);

/** 读文件并把行尾归一化成 \n，这样手写的匹配串才可能对上 */
function readNorm(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}
function writeKeep(p, text) {
  fs.writeFileSync(p, text.replace(/\n/g, '\r\n'));
}

// ---------- ① 主进程：挂到 wrap('account', ...) 那套旁边 ----------
{
  const f = path.join(root, 'apps', 'desktop', 'main.js');
  let t = readNorm(f);
  if (t.includes("'account:logout'")) {
    log('主进程：已存在');
  } else {
    const anchor = `  wrap('account', async () => {`;
    if (t.includes(anchor)) {
      const add = `  /*
   * 退出登录。
   * logout() 只清内存里的 session，落盘由 onSessionChange 那个回调负责 ——
   * 所以这里**不要自己删文件**，删了反而和回调打架。
   */
  ipcMain.handle('account:logout', async () => {
    try {
      const c = await getClient();
      c.logout();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

`;
      t = t.replace(anchor, add + anchor);
      writeKeep(f, t);
      log('ok: account:logout IPC');
    } else {
      log("!! 没找到 wrap('account'");
    }
  }
}

// ---------- ② 界面：按钮 + 绑定 ----------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'main.js');
  let t = readNorm(f);
  if (t.includes('btn-logout')) {
    log('界面：已存在');
  } else {
    const oldRender = `      : '<div>未登录</div><button id="btn-login" class="link">扫码登录酷狗</button>';`;
    const newRender = `      : '<div>未登录</div><button id="btn-login" class="link">扫码登录酷狗</button>';
    // 登录状态下才有"退出登录"；两个按钮同处一行会让下面那句绑定更好写`;
    if (!t.includes(oldRender)) {
      log('!! 没找到那行渲染');
    } else {
      // 在已登录分支的模板串后面追加一个退出按钮
      const oldLogged = `      ? \`<div class="who">\${esc(acc.nickname || '已登录')}</div><div>\${esc(acc.vipLevel || '')} · \${esc(acc.userid || '')}</div>\``;
      const newLogged = oldLogged + ` +\n        '<button id="btn-logout" class="link">退出登录</button>'`;
      if (!t.includes(oldLogged)) {
        log('!! 没找到已登录分支');
      } else {
        t = t.replace(oldLogged, newLogged);
        log('ok: 退出登录按钮');
      }
    }

    const bindOld = `  const btn = document.querySelector('#btn-login');
  if (btn) btn.addEventListener('click', () => void startQrLogin());`;
    const bindNew = `  const btn = document.querySelector('#btn-login');
  if (btn) btn.addEventListener('click', () => void startQrLogin());

  /*
   * 退出登录。
   *
   * 自己搭确认框而不用 askConfirm：后者的确定按钮文案写死是"删除"，
   * 而且它是回调式、不返回 Promise —— 语义和签名都不对，硬用只会出怪事。
   */
  const out = document.querySelector('#btn-logout');
  if (out) {
    out.addEventListener('click', () => {
      const m = mpModal('退出登录');
      const p = document.createElement('div');
      p.className = 'mp-text';
      p.textContent = '退出后需要重新扫码登录，确定吗？';
      m.body.appendChild(p);

      const ok = document.createElement('button');
      ok.className = 'mp-btn mp-btn-danger';
      ok.type = 'button';
      ok.textContent = '退出登录';
      m.foot.appendChild(ok);

      ok.addEventListener('click', async () => {
        m.close();
        const r = await api.logout();
        if (!r || !r.ok) {
          toast(\`退出失败：\${(r && r.error) || '未知错误'}\`, true);
          return;
        }
        toast('已退出登录');
        // 账号、首页（"接着听"是个人数据）、歌单全都要重来
        await loadAccount();
        await loadHome();
        await loadPlaylists();
      });
    });
  }`;
    if (t.includes(bindOld)) {
      t = t.replace(bindOld, bindNew);
      log('ok: 绑定');
    } else {
      log('!! 绑定锚点没匹配（按钮会出现但点了没反应）');
    }
    writeKeep(f, t);
  }
}

console.log('done');
