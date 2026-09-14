/*
 * 一次性补丁：给封面网点加三个**互相独立**的随机属性。
 *
 * 起因（用户原话）："每个粒子不要复用"。
 * 之前所有节拍参数都从 aPhase 一个相位推出来，等于每颗粒子只抽了一次随机，
 * 于是"深度"和"触发时机"是相关的 —— 侧面看就有结构感、像一层层的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(path.dirname(here), 'apps', 'ui', 'src', 'particles.js');
let t = fs.readFileSync(file, 'utf8');

const repl = (from, to, label) => {
  if (!t.includes(from)) {
    console.log('!! 未匹配:', label);
    return false;
  }
  t = t.replace(from, to);
  console.log('ok:', label);
  return true;
};

repl(
  '    const delays = [];',
  `    const delays = [];
    /*
     * 三个**互相独立**的随机量。
     *
     * 以前所有节拍参数都从 aPhase 一个相位推出来（fract(bph*0.777)、
     * fract(bph*0.618)…），等于每颗粒子只抽了一次随机 —— 于是"深度"和
     * "触发时刻"是**相关**的，侧面看就有结构感、像一层一层的。
     * 用户原话："每个粒子不要复用"。
     * 所以这里各发一份独立随机：深度、时机、弹跳高度各用各的。
     */
    const rndA = [];
    const rndB = [];
    const rndC = [];`,
  '① 新增 rndA/rndB/rndC'
);

repl(
  '        delays.push(Math.random()); // 逐粒延迟，聚拢时有先后，更自然',
  `        delays.push(Math.random()); // 逐粒延迟，聚拢时有先后，更自然
        rndA.push(Math.random());
        rndB.push(Math.random());
        rndC.push(Math.random());`,
  '② 每颗粒子填充'
);

repl(
  "    geo.setAttribute('aDelay', new THREE.BufferAttribute(new Float32Array(delays), 1));",
  `    geo.setAttribute('aDelay', new THREE.BufferAttribute(new Float32Array(delays), 1));
    geo.setAttribute('aRndA', new THREE.BufferAttribute(new Float32Array(rndA), 1));
    geo.setAttribute('aRndB', new THREE.BufferAttribute(new Float32Array(rndB), 1));
    geo.setAttribute('aRndC', new THREE.BufferAttribute(new Float32Array(rndC), 1));`,
  '③ 挂到 geometry'
);

repl(
  '        attribute float aPhase;\n        attribute float aDelay;',
  `        attribute float aPhase;
        attribute float aDelay;
        // 三个互相独立的随机量（见 JS 侧 rndA/rndB/rndC 的说明）
        attribute float aRndA;
        attribute float aRndB;
        attribute float aRndC;`,
  '④ 着色器声明'
);

// ⑤ 节拍块改用独立随机量
repl(
  `            float base = (fract(bph * 0.777) - 0.5) * 2.0;`,
  `            float base = (aRndA - 0.5) * 2.0;`,
  '⑤ 持续深度用 aRndA'
);

repl(
  '            float delay = fract(bph * 0.618) * 0.30;',
  '            float delay = aRndB * 0.30;',
  '⑥ 触发时机用 aRndB'
);

repl(
  '            float depth = 0.80 + 0.95 * fract(bph * 0.3183);',
  '            float depth = 0.80 + 0.95 * aRndC;',
  '⑦ 弹跳高度用 aRndC'
);

fs.writeFileSync(file, t);
console.log('written');
