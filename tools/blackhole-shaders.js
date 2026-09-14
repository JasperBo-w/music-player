/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

const BH_VERT = `
      attribute float aKind;
      attribute float aRadius;
      attribute float aAngle;
      attribute float aRnd;

      void main() {
        /*
         * 盘的"长轴"在屏幕上的方向 —— 多普勒增亮的那一侧就沿它。
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
           * 多普勒：切向速度在视空间里与视线的夹角。
           * 朝观察者运动的一侧被压亮，背面那侧暗下去 ——
           * 这是黑洞图像里最抓眼的一处不对称。
           */
          vec3 vel = vec3(-sin(ang), 0.0, cos(ang));
          vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
          float dop = dot(normalize(vv.xy + vec2(1e-5)), axis);

          /*
           * 阴影遮挡：不画黑球，而是把"该被挡住"的粒子丢出裁剪体。
           * 两个条件都要判（在中心之后 + 横向在阴影圈内），
           * 只判一条会把盘的前半或外围一起吃掉。
           */
          vec2 rel = mv.xy - vc.xy;
          if (mv.z < vc.z && length(rel) < 1.9) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            vAlpha = 0.0;
            vColor = vec3(0.0);
            return;
          }

          gl_Position = projectionMatrix * mv;

          // 内缘白热、外缘橙红（与第一版相同）
          float tR = clamp((aRadius - 4.2) / (17.0 - 4.2), 0.0, 1.0);
          vec3 hot = vec3(1.0, 0.97, 0.90);
          vec3 cool = vec3(1.0, 0.40, 0.09);
          vec3 c = mix(hot, cool, pow(tR, 0.55));
          c = mix(c * vec3(1.0, 0.52, 0.30), c, clamp(dop * 0.5 + 0.5, 0.0, 1.0));
          vColor = aColor * c * (1.0 + uPulse * 0.30);

          float dopp = pow(clamp(dop * 0.5 + 0.5, 0.0, 1.0), 2.4);
          float rim = smoothstep(0.70, 1.0, tR) * 0.45;
          vAlpha = (0.20 + dopp * 1.30) * (1.0 - tR * 0.55) + rim + uPulse * 0.05;
          gl_PointSize = aSize * uPixelRatio * (18.0 / -mv.z)
                         * (0.7 + dopp * 0.8) * (1.0 + uPulse * 0.14);
        } else if (aKind < 1.5) {
          /* ============ 光子环 / 透镜弧 ============ */
          /*
           * ★ 不要再做"整圈刚性旋转"。
           *
           * 原来是 float ang = aAngle + uTime * 0.22 —— **所有粒子同一个
           * 角速度**，看起来就是带花纹的圆盘在匀速转，很假。
           *
           * 黑洞那种"流动"的本质是**开普勒剪切**：越靠内的物质角速度越大，
           * 同一圈上的粒子因此互相错开、被拉成流动的丝。
           * 这里让每个粒子按**自己的半径**取角速度（ω ∝ r^-1.5）。
           */
          float wSpin = 3.2 / pow(max(aRadius, 0.5), 1.5);
          float ang = aAngle + uTime * wSpin;

          /*
           * 在**视空间**里搭环：中心转到视空间，再在 xy 上加一个圆。
           * 这样相机怎么转，环永远是正圆 —— 光子环本来就是这个性质。
           */
          vec3 vp = vc;
          vp.xy += vec2(cos(ang), sin(ang)) * aRadius;
          vp.z -= 0.35;

          gl_Position = projectionMatrix * vec4(vp, 1.0);

          float dop = dot(vec2(cos(ang), sin(ang)), axis);
          float dopp = pow(clamp(dop * 0.5 + 0.5, 0.0, 1.0), 2.2);

          vec3 ring = vec3(0.88, 0.93, 1.0);
          vec3 arc = vec3(1.0, 0.80, 0.52);
          float isArc = smoothstep(1.06, 1.24, aRadius / 1.9);
          vColor = aColor * mix(ring, arc, isArc) * (1.0 + uPulse * 0.35);
          vAlpha = (0.46 + dopp * 1.15) * (1.0 - isArc * 0.30) + uPulse * 0.06;
          gl_PointSize = aSize * uPixelRatio * (18.0 / -vp.z) * (1.0 + uPulse * 0.14);
        } else if (aKind < 2.5) {
          /* ============ 背景星空：引力弯折 ============ */
          vec4 mv = modelViewMatrix * vec4(position, 1.0);

          /*
           * ★ 透镜方程：  θ = (β + √(β² + 4θ_E²)) / 2
           *
           * β → 0（星正好在黑洞**正后方**）时 θ → θ_E：
           * 正后方那一整片天区的光被挤到半径 θ_E 的一圈上，
           * 于是阴影边缘出现致密的亮环，而且**
           * 黑洞背后本来该被挡住的天区，我们能看见**。
           */
          vec2 d = mv.xy - vc.xy;
          float beta = length(d);
          float RE = 2.15;
          float root = sqrt(beta * beta + 4.0 * RE * RE);
          vec2 dir = d / max(beta, 1e-4);

          /*
           * 负根 θ₂ = (β - √(β²+4θ_E²))/2 是**第二像** ——
           * 同一颗星在阴影另一侧还有一个镜像（光走了另一条路绕过来）。
           * 多半落在阴影里被丢掉，只有露在边缘外的一圈能看见。
           */
          bool second = aRnd > 0.62;
          float th = second ? 0.5 * (beta - root) : 0.5 * (beta + root);
          mv.x = vc.x + dir.x * th;
          mv.y = vc.y + dir.y * th;

          if (length(mv.xy - vc.xy) < 1.9) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            vAlpha = 0.0;
            vColor = vec3(0.0);
            return;
          }

          gl_Position = projectionMatrix * mv;
          vColor = aColor;
          // 第二像绕了远路，必然更暗；再叠一点缓慢闪烁让星空活着
          float dim = second ? 0.30 : 1.0;
          vAlpha = clamp(aColor.r, 0.0, 1.0) * dim
                   * (0.62 + 0.38 * sin(uTime * 0.8 + aPhase * 7.0)) + uPulse * 0.04;
          gl_PointSize = aSize * uPixelRatio * (52.0 / -mv.z) * (1.0 + uPulse * 0.10);
        }
      }`;

const BH_FRAG = `
      varying vec3  vColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d2 = dot(c, c);
        if (d2 > 0.25) discard;
        /*
         * 点更软：参考图整体是连续的光晕；点太硬会读成"一串珠子"，
         * 尤其盘变薄之后，硬点会直接变成虚线。
         */
        float a = smoothstep(0.25, 0.0, d2);
        a = pow(a, 1.7);
        gl_FragColor = vec4(vColor, a * clamp(vAlpha, 0.0, 1.6));
      }`;