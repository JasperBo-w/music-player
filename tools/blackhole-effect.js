/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 9. 黑洞（星际穿越那种）                                             */
/*                                                                     */
/* 四层：                                                              */
/*   吸积盘 / 光子环 / 背景星空引力弯折  —— 一个 Points，靠 aKind 分支  */
/*   时空网格（弗拉姆抛物面）            —— 一个 LineSegments          */
/* ------------------------------------------------------------------ */

function buildBlackHole(U, opts) {
  const diskCount = opts.diskCount ?? 12000;
  const lensCount = opts.lensCount ?? 7000;
  const starCount = opts.starCount ?? 11000;
  const count = diskCount + lensCount + starCount;
  const group = new THREE.Group();

  const R_SHADOW = 1.9;
  const R_IN = 2.3;
  const R_OUT = 9.4;

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
    const u = Math.random();
    const r = R_IN + (R_OUT - R_IN) * Math.pow(u, 1.7);
/*
     * ★ 角度要**聚束**，不能纯随机。
     *
     * 纯随机的粒子分布被剪切之后还是随机分布 —— 内快外慢算得再对，
     * 画面上也看不出任何东西在流动。成束之后，初始是一圈径向条纹，
     * 剪切会把条纹卷成螺旋，缠绕感就出来了。
     * 64 束：远看仍是均匀的盘，近看能看出螺旋结构。
     */
    const streamD = Math.floor(Math.random() * 64);
    const a = (streamD / 64) * TAU + (Math.random() - 0.5) * (TAU / 64) * 0.55;
    const thin = 0.025 + 0.06 * ((r - R_IN) / (R_OUT - R_IN));

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
/*
     * 环同样要成束（24 束，比盘粗一档 —— 环本身窄，束太细看不出来）。
     * 环上的束和盘上的束会各自被剪切卷开，两张图一起"淌"。
     */
    const streamL = Math.floor(Math.random() * 24);
    const a = (streamL / 24) * TAU + (Math.random() - 0.5) * (TAU / 24) * 0.6;
    const vert = Math.abs(Math.sin(a));
    /*
     * ★ 厚度差不能太大。
     *
     * 上一版是 0.10 ~ 0.95：上下极厚、左右几乎为零，结果环**断成了两坨**，
     * 中间没有东西连着 —— 用户的原话是"包裹黑洞的那个粒子，两半好丑"。
     *
     * 参考图里那圈确实也是上下宽、左右窄，但**始终是连续的一圈**，
     * 宽度差大概只有一倍。所以基准厚度提到 0.30、变化量压到 0.32：
     * 最窄处也够显眼，最宽处也不会鼓成球。
     */
    const thick = 0.3 + 0.32 * Math.pow(vert, 1.4);
    const rr = R_SHADOW * (1.03 + Math.random() * thick);

    pos[n * 3] = Math.cos(a) * rr;
    pos[n * 3 + 1] = 0;
    pos[n * 3 + 2] = Math.sin(a) * rr;

    col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = 1;
    // 点小一点：读成"流动的丝"而不是"一坨"
    size[n] = 1.1 + Math.random() * 1.5;
    phase[n] = Math.random() * TAU;
    kind[n] = 1;
    radius[n] = rr;
    angle[n] = a;
    rnd[n] = Math.random();
    n++;
  }

  /* ---------- ③ 背景星空（引力弯折） ---------- */
  for (let i = 0; i < starCount; i++) {
    const cz = Math.random() * 2 - 1;
    const sp = Math.sqrt(Math.max(0, 1 - cz * cz));
    const ph = Math.random() * TAU;
    const rr = 55 + Math.random() * 40;

    pos[n * 3] = Math.cos(ph) * sp * rr;
    pos[n * 3 + 1] = cz * rr;
    pos[n * 3 + 2] = Math.sin(ph) * sp * rr;

    const b = 0.35 + Math.pow(Math.random(), 2.4) * 0.95;
    col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = b;
    size[n] = 0.6 + Math.pow(Math.random(), 3) * 2.6;
    phase[n] = Math.random() * TAU;
    kind[n] = 2;
    radius[n] = rr;
    angle[n] = ph;
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
    makeMat(U, BH_VERT, BH_FRAG)
  );
  blackhole.frustumCulled = false;
  blackhole.userData.tintable = true;
  group.add(blackhole);

  /* ---------- ④ 时空网格（线段，不是点） ---------- */
  group.add(buildSpacetimeGrid(opts));

  return group;
}

/**
 * 时空网格：弗拉姆抛物面。
 *
 * ★ 用 LineSegments 而不是点云 —— 这是上一版失败后改的。
 *
 * 网格是"线"，用点去画它就必须撒得极密才连得起来，于是变成几千个软点、
 * 大面积 alpha 混合：**又糊又贵**（实测帧率从 165 掉到 34~54），
 * 而且密到根本看不出格子。换成线段：2100 条线就把整张网交代清楚，
 * 几乎没有填充开销，线也不会糊成一团。
 *
 * 抛物面的下陷**在 JS 里算好、烘进顶点**，不放在着色器里：
 * 这张网是静止的（物质在动、坐标系不动），没有逐帧变化，
 * 就没必要为它养一个自定义着色器 —— 用标准材质反而更好，
 * 标准材质别的地方（调色、泛光）都认。
 */
function buildSpacetimeGrid(opts) {
  const RINGS = opts.gridRings ?? 15;
  const SPOKES = opts.gridSpokes ?? 30;
  const OUT = 9.4;
  const IN = 2.0;
  const SEG = 72; // 每圈的段数
  const SPOKE_SEG = 40;

  /*
   * 史瓦西度规的嵌入图：离开洞口的高度 h(r) = 2√(R_s·(r − R_s))。
   * 减去外缘处的取值，让远处保持平的、只有洞口附近凹下去。
   */
  const rs = 1.9;
  const hEdge = 2 * Math.sqrt(rs * (OUT - rs));
  const dip = (r) => -(hEdge - 2 * Math.sqrt(rs * Math.max(r - rs, 0.001))) * 0.5;

  const verts = [];
  // 同心环
  for (let g = 0; g < RINGS; g++) {
    const rr = IN + (OUT - IN) * (g / (RINGS - 1));
    const y = dip(rr);
    for (let i = 0; i < SEG; i++) {
      const a0 = (i / SEG) * TAU;
      const a1 = ((i + 1) / SEG) * TAU;
      verts.push(Math.cos(a0) * rr, y, Math.sin(a0) * rr);
      verts.push(Math.cos(a1) * rr, y, Math.sin(a1) * rr);
    }
  }
  // 径向辐条
  for (let j = 0; j < SPOKES; j++) {
    const a = (j / SPOKES) * TAU;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let i = 0; i < SPOKE_SEG; i++) {
      const r0 = IN + (OUT - IN) * (i / SPOKE_SEG);
      const r1 = IN + (OUT - IN) * ((i + 1) / SPOKE_SEG);
      verts.push(ca * r0, dip(r0), sa * r0);
      verts.push(ca * r1, dip(r1), sa * r1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));

  const grid = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    })
  );
  // tintEffect 只认 isPoints，线段由 ParticleStage.setPalette 单独上色
  grid.userData.tintable = true;
  grid.userData.isGrid = true;
  grid.frustumCulled = false;
  return grid;
}