/*
 * 补丁：封面的前后运动改成**每颗粒子自己的阻尼振荡**。
 *
 * 用户原话："我还是感觉你又用了一层粒子（一套往前一套往后）这不是我要的"。
 *
 * 根因：持续态和跳动两项都乘同一个 base = (aRndA-0.5)*2，
 * 于是每颗粒子的正负是**固定**的 —— 正的永远在前、永远往前弹，
 * 负的永远在后、永远往后弹。位置分布虽然是连续的，
 * 但"两套粒子"的结构一直在。
 *
 * 改成：每颗粒子沿自己的时间轴做一次**阻尼振荡** ——
 * 冲出去、回摆过来、再停住。一颗就是一颗，不分套。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(path.dirname(here), 'apps', 'ui', 'src', 'particles.js');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

// 找到要替换的区间：从 "float base = (aRndA - 0.5)" 到最后一项 pos.z += 结束
let start = -1;
let end = -1;
for (let i = 0; i < lines.length; i++) {
  const s = lines[i].trim();
  if (start < 0 && s.startsWith('float base = (aRndA - 0.5)')) start = i;
  if (start >= 0 && s.startsWith('pos.z += base * imp * depth')) {
    end = i;
    break;
  }
}
if (start < 0 || end < 0) {
  console.log('!! 没找到区间 start=' + start + ' end=' + end);
  process.exit(1);
}
// 往上吃掉紧邻的注释块
let head = start;
while (head > 0 && (lines[head - 1].trim().startsWith('*') || lines[head - 1].trim().startsWith('/*') || lines[head - 1].trim().startsWith('//'))) {
  head--;
}
console.log('替换区间 ' + (head + 1) + ' .. ' + (end + 1));

const block = `            /*
             * ★★★ 每颗粒子的**阻尼振荡** —— 一颗就是一颗，不分前后两套。
             *
             * 用户："我还是感觉你又用了一层粒子（一套往前一套往后）这不是我要的"。
             *
             * 根因：之前持续态和跳动两项都乘同一个 base = (aRndA-0.5)*2，
             * 每颗粒子的正负是**固定**的 —— 正的永远在前、永远往前弹；
             * 负的永远在后、永远往后弹。位置分布连续，但"两套"的结构一直在。
             *
             * 现在改成：每颗粒子沿**自己的时间轴**做一次阻尼振荡。
             * 鼓点过后，它冲出去 → 回摆过来 → 停住。一颗粒子在一次跳动里
             * **前后都走过**，所以不存在"只往前的那一套"和"只往后的那一套"。
             *
             *   t   = uBeatAge - delay   该粒子自己的时间轴（各自延迟不同）
             *   sin(t*8)                 一个来回
             *   exp(-t*2.6)              衰减，约 1 秒停住
             *   aRndC                    各自的振幅 → 有的弹得远有的近
             *
             * 注意这里**没有 base**：位移既不按固定正负、也不按固定深度分配，
             * 完全由各自的相位与延迟决定。
             */
            float t = uBeatAge - delay;
            float osc = t < 0.0 ? 0.0 : sin(t * 8.0) * exp(-t * 2.6);
            pos.z += osc * (0.7 + 0.8 * aRndC) * uBeatAmp * 2.4 * f;`;

const out = [...lines.slice(0, head), ...block.split('\n'), ...lines.slice(end + 1)];
fs.writeFileSync(file, out.join('\r\n'));
console.log('written');
