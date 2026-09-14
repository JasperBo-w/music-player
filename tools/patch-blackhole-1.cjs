/*
 * 新效果：「黑洞」（星际穿越那种）。
 *
 * 要做出那个视觉，四个特征缺一不可 —— 少任何一个都只是"甜甜圈"：
 *   ① 事件视界：中心一块**绝对黑**的区域（不是暗，是黑）
 *   ② 吸积盘：开普勒转动（内快外慢）+ **多普勒增亮**（朝向观察者那侧亮得多）
 *   ③ 光子环：紧贴阴影边缘的一圈极亮细环
 *   ④ 引力透镜：盘的背面被弯到**上方和下方**，形成套在黑球外面的光环
 *
 * 实现上都在一个 Points 里，靠 aKind 分两条顶点路径：
 *   kind 0 吸积盘 —— 在 XZ 平面上的薄盘
 *   kind 1 光子环 / 透镜弧 —— **永远正对相机**的环
 *
 * 两个关键技巧：
 *   · 阴影靠"把粒子推出裁剪体"来做，不需要真的画一个黑球。
 *     盘上位于中心之后、且在阴影半径内的粒子直接 gl_Position 推出裁剪体
 *     （w 分量不变、坐标给 2.0），于是那块地方**干净地空出来**。
 *   · 光子环用视空间坐标搭：中心转到视空间，再在 xy 上加一个圆。
 *     这样相机无论转到哪儿，环永远是正圆 —— 这本来就是光子环的性质。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'effects.js');
let t = fs.readFileSync(f, 'utf8');
const log = (m) => console.log(m);
if (t.includes('buildBlackHole')) {
  log('已存在 buildBlackHole');
  process.exit(0);
}

const code = String.raw`
/* ------------------------------------------------------------------ */
/* 9. 黑洞（星际穿越那种）                                             */
/* ------------------------------------------------------------------ */

function buildBlackHole(U, opts) {
  const diskCount = opts.diskCount ?? 12000;
  const lensCount = opts.lensCount ?? 7000;
  const count = diskCount + lensCount;
  const group = new THREE.Group();

  /*
   * 三个半径。R_SHADOW 是事件视界的视觉半径（阴影），
   * 盘从 R_IN 起 —— 留出一点间隙，否则盘会糊在阴影边上、看不出"黑"。
   */
  const R_SHADOW = 3.4;
  const R_IN = 4.7;
  const R_OUT = 15.0;

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const kind = new Float32Array(count);
  const radius = new Float32Array(count);
  const angle = new Float32Array(count);
  const rnd = new Float32Array(count);

  let n = 0;

  /* ---------- ① 吸积盘 ---------- */
  for (let i = 0; i < diskCount; i++) {
    /*
     * 半径分布用 pow(u, 1.7) —— 内圈密、外圈疏。
     * 真实盘的面密度是外低内高的，而且视觉上最亮的就是内缘那圈。
     */
    const u = Math.random();
    const r = R_IN + (R_OUT - R_IN) * Math.pow(u, 1.7);
    const a = Math.random() * TAU;
    // 薄盘：内圈很薄，外侧略微张开（真实吸积盘也是外张的）
    const thin = 0.05 + 0.20 * ((r - R_IN) / (R_OUT - R_IN));

    pos[n * 3] = Math.cos(a) * r;
    pos[n * 3 + 1] = (Math.random() - 0.5) * thin;
    pos[n * 3 + 2] = Math.sin(a) * r;

    col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = 1;
    size[n] = (1.1 + Math.random() * 2.0) * (1.25 - 0.5 * u);
    phase[n] = Math.random() * TAU;
    kind[n] = 0;
    radius[n] = r;
    angle[n] = a;
    rnd[n] = Math.random();
    n++;
  }

  /* ---------- ② 光子环 + 透镜弧 ---------- */
  for (let i = 0; i < lensCount; i++) {
    const a = Math.random() * TAU;
    /*
     * 厚度按"上下"变化：左右两侧是薄薄的光子环，上下是透镜弧（更厚）。
     * 这就是星际穿越那张图里"盘绕到黑球上方"的那一圈。
     */
    const vert = Math.abs(Math.sin(a));
    const thick = 0.06 + 0.40 * Math.pow(vert, 1.6);
    const rr = R_SHADOW * (1.03 + Math.random() * thick);

    // 位置随便给——环的实际坐标在顶点着色器里按视空间重建
    pos[n * 3] = Math.cos(a) * rr;
    pos[n * 3 + 1] = 0;
    pos[n * 3 + 2] = Math.sin(a) * rr;

    col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = 1;
    size[n] = 1.0 + Math.random() * 1.6;
    phase[n] = Math.random() * TAU;
    kind[n] = 1;
    radius[n] = rr;
    angle[n] = a;
    rnd[n] = Math.random();
    n++;
  }

  const blackhole = new THREE.Points(
    makeGeo(pos, col, size, phase, [
      ['aKind', kind, 1],
      ['aRadius', radius, 1],
      ['aAngle', angle, 1],
      ['aRnd', rnd, 1],
    ]),
    makeMat(
      U,
      `
      attribute float aKind;
      attribute float aRadius;
      attribute float aAngle;
      attribute float aRnd;

      void main() {
        /*
         * 盘的"长轴"在屏幕上的方向 —— 多普勒亮的那一侧就沿它。
         * 取世界 +Z（盘在 XZ 平面里）投影到屏幕，所以相机转的时候
         * 亮侧会跟着一起转，不会钉死在屏幕右边。
         */
        vec2 axis = (modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xy;
        axis = normalize(axis + vec2(1e-5));
        vec3 vc = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

        if (aKind < 0.5) {
          /* ================= 吸积盘 ================= */
          vec3 pos = position;
          pos = applyBeat(pos);

          // 开普勒角速度 ∝ r^-1.5：内圈转得明显比外圈快
          float w = 9.0 / pow(max(aRadius, 1.0), 1.5);
          float ang = aAngle + uTime * w;
          mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
          pos.xz = rot * pos.xz;

          vec4 mv = modelViewMatrix * vec4(pos, 1.0);

          /*
           * 多普勒：用切向速度在视空间里与视线的夹角。
           * 朝观察者运动的一侧会被"压亮"（真实是 pow(1+βcosθ, 3)），
           * 背面那侧暗下去 —— 这是黑洞图像里最抓眼的一处不对称。
           */
          vec3 vel = vec3(-sin(ang), 0.0, cos(ang));
          vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
          float dop = dot(normalize(vv.xy + vec2(1e-5)), axis);

          /*
           * ★ 阴影遮挡：不画黑球，而是把"该被挡住"的粒子丢出裁剪体。
           * 条件是两条：在中心之后（mv.z < vc.z）、且横向距离小于阴影半径。
           * 两个都要判 —— 只判"在中心之后"会把盘的前半也吃掉，
           * 只判"在阴影圈内"会把挡在前面的那截盘也吃掉。
           */
          vec2 rel = mv.xy - vc.xy;
          if (mv.z < vc.z && length(rel) < R_SHADOW) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            vAlpha = 0.0;
            vColor = vec3(0.0);
            return;
          }

          gl_Position = projectionMatrix * mv;

          // 内缘白热、外缘橙红
          float tR = clamp((aRadius - R_IN) / (R_OUT - R_IN), 0.0, 1.0);
          vec3 hot = vec3(1.0, 0.97, 0.90);
          vec3 cool = vec3(1.0, 0.40, 0.09);
          vec3 c = mix(hot, cool, pow(tR, 0.55));
          // 背离观察者的一侧再压红一点
          c = mix(c * vec3(1.0, 0.52, 0.30), c, clamp(dop * 0.5 + 0.5, 0.0, 1.0));
          vColor = aColor * c * (1.0 + uPulse * 0.30);

          float dopp = pow(clamp(dop * 0.5 + 0.5, 0.0, 1.0), 2.4);
          vAlpha = (0.20 + dopp * 1.30) * (1.0 - tR * 0.62) + uPulse * 0.05;
          gl_PointSize = aSize * uPixelRatio * (13.0 / -mv.z)
                         * (0.6 + dopp * 0.9) * (1.0 + uPulse * 0.14);
        } else {
          /* ============ 光子环 / 透镜弧 ============ */
          // 环的角速度比盘慢得多，而且内外同速 —— 它是一张"像"，不是一个实体
          float ang = aAngle + uTime * 0.22;

          /*
           * 在**视空间**里搭环：中心转到视空间，再在 xy 上加一个圆。
           * 这样相机怎么转，环永远是正圆 —— 光子环本来就是这个性质，
           * 而如果放在世界空间里做一个圆，转到侧面就会压成一条线。
           */
          vec3 vp = vc;
          vp.xy += vec2(cos(ang), sin(ang)) * aRadius;
          // 稍微往前一点，免得和盘的中心面打架产生闪烁
          vp.z -= 0.35;

          gl_Position = projectionMatrix * vec4(vp, 1.0);

          // 和盘用同一个亮侧方向，两张图才是"同一束光"
          float dop = dot(vec2(cos(ang), sin(ang)), axis);
          float dopp = pow(clamp(dop * 0.5 + 0.5, 0.0, 1.0), 2.2);

          // 环本身近白偏蓝（高能），透镜弧被压暗压红
          vec3 ring = vec3(0.88, 0.93, 1.0);
          vec3 arc = vec3(1.0, 0.80, 0.52);
          float isArc = smoothstep(1.06, 1.24, aRadius / ${R_SHADOW.toFixed(2)});
          vColor = aColor * mix(ring, arc, isArc) * (1.0 + uPulse * 0.35);
          vAlpha = (0.42 + dopp * 0.95) * (1.0 - isArc * 0.45) + uPulse * 0.06;
          gl_PointSize = aSize * uPixelRatio * (12.5 / -vp.z * (1.0 + uPulse * 0.14));
        }
      }`
    )
  );

  blackhole.frustumCulled = false;
  blackhole.userData.tintable = true;
  group.add(blackhole);
  return group;
}

`;

// 插在 BUILDERS 之前
const anchor = 'const BUILDERS = {';
if (!t.includes(anchor)) {
  log('!! 未找到 BUILDERS');
  process.exit(1);
}
t = t.replace(anchor, code.trimStart() + '\n' + anchor);

// 注册到 BUILDERS
t = t.replace(/(\n\s*halo: buildHalo,)/, '$1\n  blackhole: buildBlackHole,');
// 加到 EFFECT_LIST
t = t.replace(
  "  { key: 'halo', name: '月蚀圣环', hint: '轨道环 + 日冕，指针推开环流' },",
  "  { key: 'halo', name: '月蚀圣环', hint: '轨道环 + 日冕，指针推开环流' },\n  { key: 'blackhole', name: '黑洞', hint: '事件视界 + 吸积盘 + 引力透镜，盘的光被弯到黑球上方' },"
);

fs.writeFileSync(f, t);
log('ok: buildBlackHole 已写入并注册');
