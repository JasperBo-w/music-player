/*
 * settings.js：注册 wave、把它设为默认、并迁移老存档。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'settings.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
let n = 0;

// ① 合法 key
if (!t.includes("'wave'")) {
  t = t.replace(
    `const EFFECT_KEYS = new Set([`,
    `const EFFECT_KEYS = new Set([\n  'wave',`
  );
  n++;
}

// ② 默认效果
if (t.includes(`effect: 'cover',`)) {
  t = t.replace(
    `effect: 'cover',`,
    `/*
   * 默认背景效果。
   *
   * 从 'cover' 改成 'wave'：用户对原来的观感不满意
   *（原话："乱挑动了感觉，有些舒缓的歌都不匹配"），
   * 要的是有规律的舒缓起伏。见 effects.js 里 buildWave 的说明。
   */
  effect: 'wave',`
  );
  n++;
}

// ③ 版本 + 迁移
const m = /const SETTINGS_VERSION = (\d+);/.exec(t);
if (m) {
  const old = Number(m[1]);
  t = t.replace(`const SETTINGS_VERSION = ${old};`, `const SETTINGS_VERSION = ${old + 1};`);

  if (!t.includes('MIGRATE_WAVE')) {
    t = t.replace(
      `    // ---- 一次性迁移 ----`,
      `    // ---- 一次性迁移 ----
    // MIGRATE_WAVE
    if ((Number(parsed.settingsVersion) || 1) <= ${old}) {
      /*
       * 把老存档的背景效果迁到「波光」。
       *
       * 只迁 'cover' 和 'spectrum'：如果用户自己选过别的（黑洞、唱片…），
       * 那是明确的偏好，不该被这次换默认值覆盖掉。
       */
      if (!parsed.effect || parsed.effect === 'spectrum') merged.effect = 'wave';
    }`
    );
    n++;
  }
}

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
console.log('settings.js 改了 ' + n + ' 处');
