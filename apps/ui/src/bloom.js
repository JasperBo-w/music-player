import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../vendor/postprocessing/Pass.js';

/**
 * 多尺度廉价泛光（CheapBloom）
 *
 * 为什么不用 three 自带的 UnrealBloomPass：
 *   它做 5 级降采样、每级两次可分离模糊，合计约 12 次全屏绘制。
 *
 * 为什么一开始的单尺度版本观感"拉了"：
 *   泛光的"lush"感来自**多尺度叠加** —— 细的一层勾出粒子的核，粗的一层把光晕
 *   铺成一片氛围。只做单尺度（1/4 分辨率一次模糊）时，光晕半径是固定的几十像素，
 *   近处看着还行，整体却缺少那层漫射的大光晕，画面就显得干、显得平。
 *
 * 这里的折中：两级金字塔。
 *   1/4 分辨率 —— 细光晕（勾核）
 *   1/8 分辨率 —— 宽光晕（铺氛围），像素量只有 1/4 分辨率的 1/4
 * 一共 6 次绘制，其中 2 次在 1/8 分辨率上，总填充量大约只有 UnrealBloom 的 1/5。
 */

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BRIGHT_FRAG = `
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  /*
   * 亮度直接取 rgb，**不要再乘 alpha**。
   *
   * 这里踩过一个坑：原本写的是 dot(c.rgb, ...) * c.a，本意是"透明区域别凭空发光"。
   * 但粒子是**加色混合**画进一个透明清屏的缓冲区的：没有粒子的地方 rgb 就已经是 0，
   * rgb 本身已经是累积出来的光强，alpha 是多余的判断。
   * 而 alpha 通常只有零点几，乘上去等于把整个亮部压低一个数量级 ——
   * 结果就是泛光几乎不工作：实测强度从 0.5 一路调到 1.8，整幅图亮度纹丝不动
   * （13.6 → 14.3），要硬拉到 2.6 才突然见效（亮部像素从 0.9% 跳到 8%）。
   * 去掉这个乘法之后，亮度响应立刻变回线性的了。
   */
  float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  // 软阈值，避免亮度在阈值附近来回跳导致闪烁
  float k = smoothstep(uThreshold, uThreshold + uKnee, lum);
  gl_FragColor = vec4(c.rgb * k, 1.0);
}
`;

const BLUR_FRAG = `
uniform sampler2D tDiffuse;
uniform vec2 uDir;          // 模糊方向，已按该级分辨率的纹素换算
varying vec2 vUv;
void main() {
  // 9 抽头高斯（5 个权重，左右对称），权重和 = 1
  vec4 sum = texture2D(tDiffuse, vUv) * 0.2270270270;
  sum += texture2D(tDiffuse, vUv + uDir * 1.0) * 0.1945945946;
  sum += texture2D(tDiffuse, vUv - uDir * 1.0) * 0.1945945946;
  sum += texture2D(tDiffuse, vUv + uDir * 2.0) * 0.1216216216;
  sum += texture2D(tDiffuse, vUv - uDir * 2.0) * 0.1216216216;
  sum += texture2D(tDiffuse, vUv + uDir * 3.0) * 0.0540540541;
  sum += texture2D(tDiffuse, vUv - uDir * 3.0) * 0.0540540541;
  sum += texture2D(tDiffuse, vUv + uDir * 4.0) * 0.0162162162;
  sum += texture2D(tDiffuse, vUv - uDir * 4.0) * 0.0162162162;
  gl_FragColor = sum;
}
`;

const COMPOSITE_FRAG = `
uniform sampler2D tDiffuse;    // 场景
uniform sampler2D tBloomFine;  // 1/4 分辨率：细光晕
uniform sampler2D tBloomWide;  // 1/8 分辨率：宽光晕
uniform float uFine;
uniform float uWide;
varying vec2 vUv;
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec3 fine = texture2D(tBloomFine, vUv).rgb;
  vec3 wide = texture2D(tBloomWide, vUv).rgb;
  // 加色叠加：细层勾核、宽层铺氛围
  gl_FragColor = vec4(base.rgb + fine * uFine + wide * uWide, base.a);
}
`;

/** 两级金字塔的分辨率因子 */
const FINE_DIV = 4;
const WIDE_DIV = 8;

export class CheapBloomPass extends Pass {
  constructor(strength = 0.9, threshold = 0.12, radius = 1.6) {
    super();

    this.strength = strength;
    this.threshold = threshold;
    this.radius = radius;

    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };

    // rtA/rtB 在 1/4 分辨率上来回倒，rtC/rtD 在 1/8 分辨率
    this.rtA = new THREE.WebGLRenderTarget(256, 256, opts);
    this.rtB = new THREE.WebGLRenderTarget(256, 256, opts);
    this.rtC = new THREE.WebGLRenderTarget(128, 128, opts);
    this.rtD = new THREE.WebGLRenderTarget(128, 128, opts);

    this._texelFine = new THREE.Vector2(1 / 256, 1 / 256);
    this._texelWide = new THREE.Vector2(1 / 128, 1 / 128);

    this.brightMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: threshold },
        uKnee: { value: 0.35 },
      },
      vertexShader: VERT,
      fragmentShader: BRIGHT_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uDir: { value: new THREE.Vector2() },
      },
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tBloomFine: { value: null },
        tBloomWide: { value: null },
        uFine: { value: strength * 0.55 },
        uWide: { value: strength * 0.85 },
      },
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });

    this.fsQuad = new FullScreenQuad(this.brightMat);
  }

  setSize(width, height) {
    const fw = Math.max(2, Math.floor(width / FINE_DIV));
    const fh = Math.max(2, Math.floor(height / FINE_DIV));
    const ww = Math.max(2, Math.floor(width / WIDE_DIV));
    const wh = Math.max(2, Math.floor(height / WIDE_DIV));
    this.rtA.setSize(fw, fh);
    this.rtB.setSize(fw, fh);
    this.rtC.setSize(ww, wh);
    this.rtD.setSize(ww, wh);
    this._texelFine.set(1 / fw, 1 / fh);
    this._texelWide.set(1 / ww, 1 / wh);
  }

  /**
   * 设置泛光强度。
   *
   * 细层和宽层给不同权重：宽层（1/8 分辨率那级）权重更高，因为
   * "光晕铺开成氛围"主要靠它 —— 只加细层会让粒子变亮而不是变"发光"。
   */
  setStrength(v) {
    this.strength = v;
    this.compositeMat.uniforms.uFine.value = v * 0.55;
    this.compositeMat.uniforms.uWide.value = v * 0.85;
  }

  setThreshold(v) {
    this.threshold = v;
    this.brightMat.uniforms.uThreshold.value = v;
  }

  /** 宽层模糊步长倍率，调大 = 光晕更散 */
  setRadius(v) {
    this.radius = v;
  }

  render(renderer, writeBuffer, readBuffer) {
    const tf = this._texelFine;
    const tw = this._texelWide;

    // ---- 1. 亮度提取 + 降到 1/4 ----
    this.fsQuad.material = this.brightMat;
    this.brightMat.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.rtA);
    this.fsQuad.render(renderer);

    // ---- 2/3. 1/4 分辨率上横竖各模糊一次 → 细光晕 ----
    this.fsQuad.material = this.blurMat;
    this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
    this.blurMat.uniforms.uDir.value.set(tf.x * this.radius, 0);
    renderer.setRenderTarget(this.rtB);
    this.fsQuad.render(renderer);

    this.blurMat.uniforms.tDiffuse.value = this.rtB.texture;
    this.blurMat.uniforms.uDir.value.set(0, tf.y * this.radius);
    renderer.setRenderTarget(this.rtA);
    this.fsQuad.render(renderer);

    // ---- 4/5. 继续降到 1/8 再横竖模糊 → 宽光晕 ----
    // 步长按 1/8 分辨率的纹素算，所以同样的抽头数能覆盖两倍的距离
    this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
    this.blurMat.uniforms.uDir.value.set(tw.x * this.radius * 1.7, 0);
    renderer.setRenderTarget(this.rtC);
    this.fsQuad.render(renderer);

    this.blurMat.uniforms.tDiffuse.value = this.rtC.texture;
    this.blurMat.uniforms.uDir.value.set(0, tw.y * this.radius * 1.7);
    renderer.setRenderTarget(this.rtD);
    this.fsQuad.render(renderer);

    // ---- 6. 合成：场景 + 细光晕 + 宽光晕 ----
    this.fsQuad.material = this.compositeMat;
    this.compositeMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMat.uniforms.tBloomFine.value = this.rtA.texture;
    this.compositeMat.uniforms.tBloomWide.value = this.rtD.texture;

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.rtC.dispose();
    this.rtD.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.fsQuad.dispose();
  }
}
