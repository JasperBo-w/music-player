/*
 * 修「鼠标推开粒子」的位置偏移。
 *
 * 用户原话："有的粒子效果…鼠标移动就有个小黑洞，那个黑洞偏移，
 *           鼠标不跟在中心"。
 *
 * 原因：uPointer 是归一化的 [-1,1]，而各个效果**各自乘一个系数**
 * （8.0 / 8.5 / 11.0 / 14.0 / 15.0）把它当成世界坐标用：
 *
 *     vec2 d = pos.xy - uPointer * 8.5;
 *
 * 但相机在半径 9、fov 52° 时，屏幕可见范围只有
 *     半高 = tan(26°) × 9 ≈ 4.4
 *     半宽 = 4.4 × (1240/802) ≈ 6.8
 * 乘 8~15 是它的 2~3.4 倍 —— 那个"洞"早就跑到画面外了，
 * 所以看起来完全不跟鼠标。
 *
 * 修法：**在源头换算一次**，让 uPointer 直接就是世界坐标，
 * 各效果用它时不需要再乘系数。这样以后加新效果也不会再各乘各的。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const log = (m) => console.log(m);

// ---------- ① particles.js：把指针换算成世界坐标 ----------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'particles.js');
  let t = fs.readFileSync(f, 'utf8');
  const old = `    const p = U.uPointer.value;
    p.x += (this.pointerTarget.x - p.x) * Math.min(1, dt * 5);
    p.y += (this.pointerTarget.y - p.y) * Math.min(1, dt * 5);`;
  const neu = `    /*
     * ★ 指针要换算成**世界坐标**再交给着色器。
     *
     * 各效果里写的是 \`pos.xy - uPointer * K\`，K 从 8 到 15 不等 ——
     * 而屏幕可见范围只有半高约 4.4、半宽约 6.8（相机半径 9、fov 52°）。
     * 乘那么大等于把那个"推开粒子的洞"扔到画面外，所以完全不跟鼠标。
     *
     * 这里按相机的实际可视范围换算一次：半高 = tan(fov/2) × 距离，
     * 半宽 = 半高 × 宽高比。各效果直接用它就行，不要再乘系数。
     */
    const halfH = Math.tan(((this.camera.fov || 52) * Math.PI) / 180 / 2) * Math.abs(this.orbit.radius || 9);
    const halfW = halfH * (this.camera.aspect || 1.6);
    const p = U.uPointer.value;
    const tx = this.pointerTarget.x * halfW;
    const ty = this.pointerTarget.y * halfH;
    p.x += (tx - p.x) * Math.min(1, dt * 5);
    p.y += (ty - p.y) * Math.min(1, dt * 5);`;
  if (t.includes(old)) {
    t = t.replace(old, neu);
    fs.writeFileSync(f, t);
    log('ok: particles.js 指针换算');
  } else {
    log('!! particles.js 未匹配');
  }
}

// ---------- ② effects.js：去掉各效果里的系数 ----------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'effects.js');
  let t = fs.readFileSync(f, 'utf8');
  let n = 0;
  for (const k of ['8.0', '8.5', '11.0', '14.0', '15.0']) {
    const from = `uPointer * ${k}`;
    if (t.includes(from)) {
      t = t.replace(from, 'uPointer');
      n++;
    }
  }
  // VERT_HEAD 里那两个小幅摆动也跟着换算一次（原来按归一化坐标写的 0.45/0.32）
  const swayOld = `float swayY = sin(uTime * 0.23) * 0.30 + uPointer.x * 0.45 * uPointerStrength;
        float swayX = cos(uTime * 0.18) * 0.15 - uPointer.y * 0.32 * uPointerStrength;`;
  const swayNew = `/*
         * 这两个是"整体随风轻摆"，系数要跟着 uPointer 的单位一起改 ——
         * uPointer 从归一化变成世界坐标（量级大了约 5 倍），
         * 系数不同步的话光是把鼠标移到边上，整个粒子场就会甩出去。
         */
        float swayY = sin(uTime * 0.23) * 0.30 + uPointer.x * 0.09 * uPointerStrength;
        float swayX = cos(uTime * 0.18) * 0.15 - uPointer.y * 0.07 * uPointerStrength;`;
  if (t.includes(swayOld)) {
    t = t.replace(swayOld, swayNew);
    n++;
  }
  fs.writeFileSync(f, t);
  log(`ok: effects.js 去掉 ${n} 处系数`);
}

console.log('done');
