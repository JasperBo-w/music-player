/*
 * 两处修正（用户反馈）：
 *
 * ① "应该是声纹星盘那种类型的才用这种复位的"
 *    —— 暂停复位（uTime 收回 0）只给时间驱动的效果，封面不做。
 *       封面本来就是一张静止的网点图 + 由 uPulse 驱动的跳动，
 *       暂停时 uPulse 自然归零就够了，不需要再把它"倒带"。
 *
 * ② "封面虽然不见了，但是别把歌词去掉啊"
 *    —— 上一版我把舞台文字**跟着封面一起门控**了，做过头了：
 *       换成星盘之后歌词也一起没了。改成文字始终显示，只门控封面网点。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const pf = path.join(root, 'apps', 'ui', 'src', 'particles.js');
let t = fs.readFileSync(pf, 'utf8');
const log = (m) => console.log(m);

// ---- ① 舞台文字不再跟封面一起门控 ----
const fromStage = `        // 舞台文字跟封面同进同出（它本来就是封面构图的一部分）
        if (this.stageFront) {
          const stageOn = coverStageOn && !!this._stageKey;
          this.stageFront.visible = stageOn;
          this.stageRear.visible = stageOn;
        }`;
const toStage = `        /*
         * 舞台文字**不跟着封面一起收**。
         *
         * 我上一版把它们绑在一起（理由是"文字是封面构图的一部分"），
         * 做过头了 —— 用户："封面虽然不见了，但是别把歌词去掉啊"。
         * 现在只有封面网点受效果门控，歌词/歌名在任何效果下都显示。
         * （可见性由 setStageText 自己管：没文字时它会置 false。）
         */`;
if (t.includes(fromStage)) {
  t = t.replace(fromStage, toStage);
  log('ok: 文字不再跟封面一起门控');
} else {
  log('!! 未匹配 文字门控段');
}

// ---- ② 暂停复位只给非封面效果 ----
const fromReset = `    if (this.playing) {
      this.elapsed += dt;
    } else if (this.elapsed > 1e-4) {`;
const toReset = `    /*
     * ★ 复位只给"声纹星盘那种"时间驱动的效果，**封面不做**。
     *
     * 用户："应该是声纹星盘那种类型的才用这种复位的"。
     * 封面本来就是一张静止的网点图，只有 uPulse 驱动的跳动 ——
     * 暂停时 uPulse 自己归零就够了；再把它"倒带"反而多此一举。
     */
    const wantReset = this.effectKey !== 'cover';
    if (this.playing || !wantReset) {
      this.elapsed += dt;
    } else if (this.elapsed > 1e-4) {`;
if (t.includes(fromReset)) {
  t = t.replace(fromReset, toReset);
  log('ok: 复位只给非封面效果');
} else {
  log('!! 未匹配 复位段');
}

fs.writeFileSync(pf, t);
console.log('done');
