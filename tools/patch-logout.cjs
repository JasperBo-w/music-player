/*
 * 退出登录 / 切换账号。
 *
 * core 里早就有 logout()（清空本地会话 + 通知落盘），但**没有任何入口调用它** ——
 * 和之前 uploadPlayHistory 的情况一样：能力做了，没接线。
 * 这一版把线接上：主进程一条 IPC，界面一个按钮。
 *
 * "切换账号"不单独做 —— 它就是"退出 → 再扫码"，多一个按钮只会让用户
 * 以为还有别的意思。退出按钮下面给一句提示就够了。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const log = (m) => console.log(m);

// ---------- ① 主进程 IPC ----------
{
  const f = path.join(root, 'apps', 'desktop', 'main.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes("'account:logout'")) {
    log('主进程：已存在');
  } else {
    const anchor = `  ipcMain.handle('account'`;
    if (t.includes(anchor)) {
      const add = `  /*
   * 退出登录。
   * logout() 只清内存里的 session，onSessionChange 那个回调负责落盘 ——
   * 所以这里不需要自己删文件，删了反而会和回调打架。
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
      fs.writeFileSync(f, t);
      log('ok: account:logout IPC');
    } else {
      log("!! 没找到 ipcMain.handle('account'");
    }
  }
}

// ---------- ② preload ----------
{
  const f = path.join(root, 'apps', 'desktop', 'preload.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('logout:')) {
    log('preload：已存在');
  } else {
    const anchor = `  account: () => ipcRenderer.invoke('account'),`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, anchor + `\n  /** 退出登录（清本地会话） */\n  logout: () => ipcRenderer.invoke('account:logout'),`);
      fs.writeFileSync(f, t);
      log('ok: preload logout');
    } else {
      log('!! 没找到 preload 的 account');
    }
  }
}

// ---------- ③ 界面按钮 ----------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'main.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('btn-logout')) {
    log('界面：已存在');
  } else {
    const old = `    box.innerHTML = acc.loggedIn
      ? \`<div class="who">\${esc(acc.nickname || '已登录')}</div><div>\${esc(acc.vipLevel || '')} · \${esc(acc.userid || '')}</div>\`
      : '<div>未登录</div><button id="btn-login" class="link">扫码登录酷狗</button>';`;
    const neu = `    box.innerHTML = acc.loggedIn
      ? \`<div class="who">\${esc(acc.nickname || '已登录')}</div><div>\${esc(acc.vipLevel || '')} · \${esc(acc.userid || '')}</div>\` +
        '<button id="btn-logout" class="link">退出登录</button>'
      : '<div>未登录</div><button id="btn-login" class="link">扫码登录酷狗</button>';`;
    if (t.includes(old)) {
      t = t.replace(old, neu);
      // 绑定
      const bindOld = `  const btn = document.querySelector('#btn-login');
  if (btn) btn.addEventListener('click', () => void startQrLogin());`;
      const bindNew = `  const btn = document.querySelector('#btn-login');
  if (btn) btn.addEventListener('click', () => void startQrLogin());

  /*
   * 退出登录。要二次确认 —— 这是个不可逆的动作（虽然能重新扫码登录，
   * 但本地会话、歌单缓存都得重来一遍）。复用界面已有的 askConfirm。
   */
  const out = document.querySelector('#btn-logout');
  if (out) {
    out.addEventListener('click', async () => {
      const yes = await askConfirm('退出登录', '退出后需要重新扫码登录，确定吗？');
      if (!yes) return;
      const r = await api.logout();
      if (!r || !r.ok) {
        toast(\`退出失败：\${(r && r.error) || '未知错误'}\`, true);
        return;
      }
      toast('已退出登录');
      // 账号、首页（"接着听"里有个人数据）、歌单都要重来
      await loadAccount();
      await loadHome();
      await loadPlaylists();
    });
  }`;
      if (t.includes(bindOld)) {
        t = t.replace(bindOld, bindNew);
        log('ok: 界面按钮 + 绑定');
      } else {
        log('!! 找到渲染但那句绑定没匹配（按钮会出现但点了没反应）');
      }
      fs.writeFileSync(f, t);
    } else {
      log('!! 没找到 loadAccount 里那段渲染');
    }
  }
}

console.log('done');
