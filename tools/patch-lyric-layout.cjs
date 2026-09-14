/*
 * 桌面歌词的排版：改成绝对定位 + text-align:center。
 *
 * 起因：文字一直**贴在右边**，没有居中。原来用的是
 *   #wrap { display:flex; flex-direction:column; align-items:center; justify-content:center }
 * 在这套透明窗口里显然没按预期工作，而我**没法在里面调试**
 *（那个窗口没有开发者工具可用，我也没有从外部查它 DOM 的手段）。
 *
 * 所以不再去猜 flex 为什么失效，换成一种"不依赖容器宽度计算"的写法：
 *   · #main / #next 绝对定位，left:0 + right:0 → 宽度恒等于视口宽度
 *   · text-align:center → 居中由文字排版自己完成，不经过 flex 的尺寸协商
 *   · 纵向位置用 top 百分比定，也不依赖 flex 的居中
 *
 * 这类"我无法观测的界面"，就该用最不依赖隐式行为的写法 ——
 * 猜错一次的代价是用户看到一坨错位的东西，而我这边看不出异常。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'lyric.html');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

// ① #wrap 不再靠 flex 居中
const oldWrap = `      #wrap {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 8px 18px;
        /* 整窗可拖 —— 桌面歌词必须能挪到不挡事的地方 */
        -webkit-app-region: drag;
        text-align: center;
      }`;
const newWrap = `      /*
       * 用绝对定位 + text-align 居中，**不用 flex**。
       *
       * 之前用 flex 的时候文字一直贴在右边 —— 透明窗口里我没法调它的 DOM，
       * 猜不出 flex 为什么失效，所以换成不依赖容器宽度协商的写法：
       * left:0 + right:0 让宽度恒等于视口宽度，居中交给文字排版自己做。
       */
      #wrap {
        position: absolute;
        inset: 0;
        /* 整窗可拖 —— 桌面歌词必须能挪到不挡事的地方 */
        -webkit-app-region: drag;
      }`;
if (t.includes(oldWrap)) {
  t = t.replace(oldWrap, newWrap);
  log('ok: #wrap');
} else {
  log('!! #wrap 没匹配');
}

// ② #main 绝对定位居中
const oldMain = `      #main {
        font-size: 30px;`;
const newMain = `      #main {
        position: absolute;
        left: 0;
        right: 0;
        top: 22%;
        padding: 0 14px;
        text-align: center;
        font-size: 28px;`;
if (t.includes(oldMain)) {
  t = t.replace(oldMain, newMain);
  log('ok: #main');
} else {
  log('!! #main 没匹配');
}

// ③ #next 绝对定位居中
const oldNext = `      #next {
        font-size: 15px;`;
const newNext = `      #next {
        position: absolute;
        left: 0;
        right: 0;
        top: 64%;
        padding: 0 14px;
        text-align: center;
        font-size: 15px;`;
if (t.includes(oldNext)) {
  t = t.replace(oldNext, newNext);
  log('ok: #next');
} else {
  log('!! #next 没匹配');
}

// ④ 去掉 #main 上的 max-width/nowrap 组合（它和 text-align:center 会打架：
//    nowrap 让文字不换行、max-width 又把它夹窄，居中就没意义了）
t = t.replace(`        max-width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #next {`, `        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #next {`);

// ⑤ 长句子允许折行，不然超宽只会被裁掉
t = t.replace(
  `        max-width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* 没歌词时显示歌名，别留一块空白 */`,
  `        overflow: hidden;
      }

      /* 没歌词时显示歌名，别留一块空白 */`
);

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
console.log('done');
