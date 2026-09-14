/*
 * 「存在感基线」：把两个偏暗偏小的效果提上来。
 *
 * 单独审查七个效果时发现的共性问题：形态都对，但**基色几乎为零** ——
 *   声纹长卷 vAlpha = 0.035 + amp*0.62
 *   光珊瑚   vAlpha = 0.055 + aAlong*0.05 + ...
 * 静音段基本是黑的，配上界面就完全看不见。这大概是我早期为了修"泛光过曝"
 * 一路往下压亮度的后遗症 —— 压到单独看还行，放进实际界面就没了。
 *
 * 同时点径也偏小（长卷 7.2，其余效果在 11~14），一并提上来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(path.dirname(here), 'apps', 'ui', 'src', 'effects.js');
let t = fs.readFileSync(file, 'utf8');
const log = (m) => console.log(m);

const rep = (from, to, label) => {
  if (!t.includes(from)) {
    log('!! 未匹配: ' + label);
    return;
  }
  t = t.replace(from, to);
  log('ok: ' + label);
};

// ① 声纹长卷：基色 0.035 → 0.12，动态部分也提上来
rep(
  '        vAlpha = 0.035 + amp * 0.62;',
  `        /*
         * 基色从 0.035 提到 0.12。
         * 原来静音段几乎是纯黑 —— 七个效果单独审查时才看出来：
         * 形态是对的，但配上界面就完全看不见。
         */
        vAlpha = 0.12 + amp * 0.80;`,
  '长卷 alpha'
);

// ② 声纹长卷：点径 7.2 → 9.5
rep(
  '        gl_PointSize = aSize * uPixelRatio * (7.2 / -mv.z) * (0.75 + amp * 1.9);',
  '        gl_PointSize = aSize * uPixelRatio * (9.5 / -mv.z) * (0.75 + amp * 1.9);',
  '长卷点径'
);

// ③ 光珊瑚：基色 0.055 → 0.16，各项同步抬
rep(
  '        vAlpha = 0.055 + aAlong * 0.05 + wave * 0.72 + tip * 0.34;',
  `        /*
         * 基色 0.055 → 0.16。理由同长卷：形态正确但存在感不足，
         * 枝条在界面上几乎看不见，只剩梢头几点。
         */
        vAlpha = 0.16 + aAlong * 0.09 + wave * 0.92 + tip * 0.46;`,
  '珊瑚 alpha'
);

fs.writeFileSync(file, t);
console.log('done');
