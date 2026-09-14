/*
 * electron-builder 的 afterPack 钩子：裁剪 Electron 语言包。
 *
 * 为什么用钩子而不是 files 里的排除 glob：
 * electron-builder 没有"只保留某些语言"的正式选项（它仓库里的已知 issue），
 * 靠取反 glob 在不同版本上支持不一致，而**不生效时是静默通过的** ——
 * 你只会看到安装包体积没变，不知道是配置没起作用还是别的原因。
 * afterPack 在"应用目录已经铺好、安装器还没生成"这个确切时刻执行，
 * 删掉的就是最终会被压进安装包的那些文件，确定性最高。
 *
 * 时机很关键：语言包会原样进入 NSIS 安装包，所以必须在这里删，
 * 等安装器出来再删就没用了。
 *
 * 数据结构（Electron 42 实测）：
 *   <appOutDir>/locales/*.pak   55 个，合计 47.18 MB
 *   只留 zh-CN / zh-TW / en-US / en-GB   2.18 MB
 *
 * 这个文件按 CommonJS 写，因为 electron-builder 用它自己的加载器 require 它。
 */

const fs = require('fs');
const path = require('path');

/** 保留的语言。中文是界面语言，英文作为看不懂中文时的兜底。 */
const KEEP = ['zh-CN', 'zh-TW', 'en-US', 'en-GB'];

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;

  // macOS 的语言包在 Resources 下，Windows/Linux 直接在根
  const candidates = [
    path.join(appOutDir, 'locales'),
    path.join(appOutDir, 'Resources', 'locales')
  ];
  const localesDir = candidates.find((d) => fs.existsSync(d));

  if (!localesDir) {
    console.log('[trim-locales] 没有找到 locales 目录，跳过');
    return;
  }

  const all = fs.readdirSync(localesDir).filter((f) => f.endsWith('.pak'));
  if (all.length === 0) {
    console.log('[trim-locales] locales 目录是空的，跳过');
    return;
  }

  /*
   * 安全检查：必须能找到要保留的语言。
   * 如果 Electron 换了目录结构或改了命名，宁可什么都不删 ——
   * 删错语言包会让界面变成"找不到语言文件"的空白，比体积大严重得多。
   */
  const keepFiles = all.filter((f) => KEEP.includes(path.basename(f, '.pak')));
  if (keepFiles.length === 0) {
    console.log('[trim-locales] 警告：没找到任何一个要保留的语言包，本次不裁剪');
    console.log('[trim-locales] 目录内容:', all.slice(0, 8).join(', '), '...');
    return;
  }

  const sizeOf = (files) =>
    files.reduce((sum, f) => sum + fs.statSync(path.join(localesDir, f)).size, 0);

  const toDelete = all.filter((f) => !KEEP.includes(path.basename(f, '.pak')));
  const beforeMB = sizeOf(all) / 1024 / 1024;
  const keepMB = sizeOf(keepFiles) / 1024 / 1024;

  for (const f of toDelete) {
    try {
      fs.unlinkSync(path.join(localesDir, f));
    } catch (e) {
      console.log(`[trim-locales] 删不掉 ${f}: ${e.message}`);
    }
  }

  const after = fs.readdirSync(localesDir).filter((f) => f.endsWith('.pak'));
  const afterMB = sizeOf(after) / 1024 / 1024;

  console.log(
    `[trim-locales] 语言包 ${all.length} -> ${after.length} 个，` +
      `${beforeMB.toFixed(2)} MB -> ${afterMB.toFixed(2)} MB ` +
      `（删了 ${toDelete.length} 个，省 ${(beforeMB - afterMB).toFixed(2)} MB）`
  );
  console.log(`[trim-locales] 保留: ${after.map((f) => path.basename(f, '.pak')).join(', ')}`);
};
