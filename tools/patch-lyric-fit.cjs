/*
 * 桌面歌词两件事：
 *   ① 排版改成绝对定位 + text-align:center（原来 flex 居中失效，文字贴右）
 *   ② 窗口**按文字实际尺寸收缩**，不留一大块透明区域挡鼠标
 *
 * ② 的由来：用户说"歌词文字在哪框就在哪，不要多出透明的边框挡"。
 * 原来窗口是固定的 880×132，只有中间一点是字，其余全是透明的挡道区域 ——
 * 从用户角度看就是"明明没东西，鼠标却点不过去"。
 *
 * 做法：歌词窗口渲染完量一次 #main / #next 的实际外接矩形（含柔光的余量），
 * 把尺寸报给主进程去 setBounds。**缩放时保持窗口中心不动** ——
 * 否则字会随着窗口缩小而整体偏移，看起来像在跳。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const htmlFile = path.join(root, 'apps', 'ui', 'lyric.html');
const preloadFile = path.join(root, 'apps', 'desktop', 'preload.js');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const log = (m) => console.log(m);

const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① 主进程：接收尺寸 ----------
{
  let t = readNorm(mainFile);
  if (t.includes("'lyric:resize'")) {
    log('主进程：已存在');
  } else {
    const anchor = `  ipcMain.handle('lyric:visible'`;
    const add = `  /*
   * 按文字尺寸收缩窗口。
   *
   * 保持**中心不动**：加 padding 的时候如果锚在左上角，
   * 字会随着窗口一起挪，看起来像在跳。
   *
   * 夹一个下限 —— 歌词为空时量出来可能是 0 宽，窗口缩成一条线就再也拖不到了。
   */
  ipcMain.handle('lyric:resize', (_e, size) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return false;
    const w = Math.max(160, Math.min(4000, Math.round(Number(size && size.w) || 0)));
    const h = Math.max(46, Math.min(600, Math.round(Number(size && size.h) || 0)));
    const b = lyricWindow.getBounds();
    if (Math.abs(b.width - w) < 2 && Math.abs(b.height - h) < 2) return true; // 没变就别动，免得抖
    lyricWindow.setBounds({
      x: Math.round(b.x + (b.width - w) / 2),
      y: Math.round(b.y + (b.height - h) / 2),
      width: w,
      height: h,
    });
    return true;
  });

`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, add + anchor);
      writeNorm(mainFile, t);
      log('ok: lyric:resize IPC');
    } else {
      log('!! 没找到 lyric:visible');
    }
  }

  // 窗口要允许程序改尺寸（resizable:false 在部分平台会挡住 setBounds）
  let t2 = readNorm(mainFile);
  if (t2.includes('resizable: false,\n    movable: true,')) {
    t2 = t2.replace(
      'resizable: false,\n    movable: true,',
      '/* 程序要按文字尺寸改它，所以不能锁死；无边框下用户也拖不到边框 */\n    resizable: true,\n    movable: true,'
    );
    writeNorm(mainFile, t2);
    log('ok: resizable');
  }
}

// ---------- ② preload ----------
{
  let t = readNorm(preloadFile);
  if (t.includes('resize:')) {
    log('preload：已存在');
  } else {
    const anchor = `    visible: () => ipcRenderer.invoke('lyric:visible'),`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, anchor + `\n    /** 歌词窗口量完文字尺寸后报给主进程，让窗口贴合文字 */\n    resize: (size) => ipcRenderer.invoke('lyric:resize', size),`);
      writeNorm(preloadFile, t);
      log('ok: preload resize');
    } else {
      log('!! 没找到 preload visible');
    }
  }
}

// ---------- ③ 歌词窗口：绝对定位 + 量尺寸 ----------
{
  let t = readNorm(htmlFile);

  // 3.1 #wrap 不再用 flex 居中
  const oldWrap = t.slice(t.indexOf('      #wrap {'), t.indexOf('      /*', t.indexOf('      #wrap {')));
  if (oldWrap.includes('display: flex')) {
    t = t.replace(
      oldWrap,
      `      /*
       * 绝对定位 + text-align 居中，**不用 flex**。
       *
       * 之前用 flex 时文字一直贴在右边 —— 这个透明窗口我这边没有调试手段，
       * 猜不出 flex 为什么失效。所以换成不依赖容器尺寸协商的写法：
       * left:0 + right:0 让宽度恒等于视口宽度，居中交给文字排版自己做。
       */
      #wrap {
        position: absolute;
        inset: 0;
        /* 整窗可拖 —— 桌面歌词必须能挪到不挡事的地方 */
        -webkit-app-region: drag;
      }

`
    );
    log('ok: #wrap 改绝对定位');
  }

  // 3.2 #main / #next 绝对定位居中
  if (!t.includes('position: absolute;\n        left: 0;\n        right: 0;\n        top: 22%;')) {
    t = t.replace(
      `      #main {
        font-size: 30px;`,
      `      #main {
        position: absolute;
        left: 0;
        right: 0;
        top: 20%;
        padding: 0 22px;
        text-align: center;
        font-size: 28px;`
    );
    t = t.replace(
      `      #next {
        font-size: 15px;`,
      `      #next {
        position: absolute;
        left: 0;
        right: 0;
        top: 62%;
        padding: 0 22px;
        text-align: center;
        font-size: 15px;`
    );
    log('ok: #main / #next 绝对定位');
  }

  // 3.3 量尺寸并上报
  if (!t.includes('reportSize')) {
    const anchor = `      window.api.desktopLyric.onLock((locked) => {`;
    const add = `      /*
       * 量出文字的实际外接矩形，报给主进程去收缩窗口。
       *
       * 为什么不是"把窗口设成固定小尺寸"：歌词长度每句都不一样，
       * 固定尺寸必然要么裁掉长句、要么给短句留一大片透明挡道区。
       * 只有量了真实的排版结果，才能做到"字在哪框就在哪"。
       *
       * 尺寸里要含 PAD：柔光阴影是往外画的，紧贴文字会被窗口裁掉一圈。
       */
      const PAD_X = 26;
      const PAD_Y = 14;
      let lastSize = '';

      function reportSize() {
        const rects = [mainEl, nextEl]
          .filter((el) => el && el.offsetParent !== null && el.textContent.trim() !== '')
          .map((el) => el.getBoundingClientRect());
        if (!rects.length) return;
        const left = Math.min(...rects.map((r) => r.left));
        const right = Math.max(...rects.map((r) => r.right));
        const top = Math.min(...rects.map((r) => r.top));
        const bottom = Math.max(...rects.map((r) => r.bottom));
        const w = Math.ceil(right - left) + PAD_X * 2;
        const h = Math.ceil(bottom - top) + PAD_Y * 2;
        const key = w + 'x' + h;
        if (key === lastSize) return; // 没变就别反复调 setBounds，会抖
        lastSize = key;
        window.api.desktopLyric.resize({ w, h });
      }

${anchor}`;
    t = t.replace(anchor, add);

    // 每次更新文字后量一次
    t = t.replace(
      `        if (nextEl.textContent !== (p.next || '')) nextEl.textContent = p.next || '';
      });`,
      `        if (nextEl.textContent !== (p.next || '')) nextEl.textContent = p.next || '';

        // 排版是异步的，等这一帧画完再量，否则量到的是旧尺寸
        requestAnimationFrame(reportSize);
      });

      // 字体加载完尺寸会变，补量一次
      if (document.fonts && document.fonts.ready) void document.fonts.ready.then(reportSize);`
    );
    log('ok: 量尺寸上报');
  }

  writeNorm(htmlFile, t);
}

console.log('done');
