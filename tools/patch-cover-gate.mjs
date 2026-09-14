/*
 * 补丁：封面层（网点 + 舞台文字）只在不「封面粒子」这个效果里显示。
 *
 * 用户原话："封面只有在封面效果才显示，别的粒子效果要么不显示要么你想个风格，
 * 放在不挡画面的"。
 *
 * 为什么必须这么做：封面那层是铺满整屏的半透明网点大平面 + 一块 9.6 世界单位宽
 * 的文字板。换成声纹星盘、粒子雨这些效果时，它们全被压在下面 ——
 * 等于"每个效果都透过一层纱在看"，谁也看不清。
 *
 * 这里取"只在这个效果里显示"（用户给的两个选项里更干净的那个）：
 * 换成别的效果，封面和舞台文字一起收起来，画面完全让给那个效果。
 * 功能都没删，切回「封面粒子」立刻回来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(path.dirname(here), 'apps', 'ui', 'src', 'particles.js');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

let idx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('this.coverPoints.visible = form.value > 0.012')) {
    idx = i;
    break;
  }
}
if (idx < 0) {
  console.log('!! 没找到 coverPoints.visible');
  process.exit(1);
}

const block = [
  '        /*',
  '         * ★ 封面层只在「封面粒子」这个效果里显示。',
  '         *',
  '         * 用户："封面只有在封面效果才显示，别的粒子效果要么不显示要么',
  '         * 你想个风格，放在不挡画面的"。',
  '         *',
  '         * 封面是铺满整屏的半透明网点平面 + 一块很宽的文字板，',
  '         * 换成声纹星盘、粒子雨这些效果时会把它们全压住 ——',
  '         * 等于每个效果都隔着一层纱在看。所以这里取用户给的第一个选项：',
  '         * 只在这个效果里出现，其余效果把画面完整让出来。',
  '         *',
  '         * 功能都没删：切回「封面粒子」立刻回来。',
  '         */',
  '        const coverStageOn = this.effectKey === \'cover\';',
  '        this.coverPoints.visible =',
  '          coverStageOn && form.value > 0.012 && !this.benchHideCover;',
  '        // 舞台文字跟封面同进同出（它本来就是封面构图的一部分）',
  '        if (this.stageFront) {',
  '          const stageOn = coverStageOn && !!this._stageKey;',
  '          this.stageFront.visible = stageOn;',
  '          this.stageRear.visible = stageOn;',
  '        }',
];

// 往上吃掉紧邻的注释块（原来那段说明整块替换掉）
let head = idx;
while (
  head > 0 &&
  (lines[head - 1].trim().startsWith('*') ||
    lines[head - 1].trim().startsWith('/*') ||
    lines[head - 1].trim().startsWith('//'))
) {
  head--;
}

const out = [...lines.slice(0, head), ...block, ...lines.slice(idx + 1)];
fs.writeFileSync(file, out.join('\r\n'));
console.log('替换 ' + (head + 1) + '..' + (idx + 1) + ' 行 → 已加效果门控');
