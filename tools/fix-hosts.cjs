/*
 * 删掉 hosts 里所有和 github 相关的屏蔽记录。
 *
 * 为什么需要管理员：C:\Windows\System32\drivers\etc\ 受 Windows ACL 保护，
 * 普通权限写入会 EPERM（DSH 的沙箱提权解决不了这个 —— 那是文件访问权限，
 * 不是 Windows 管理员令牌）。
 *
 * 所以这个脚本要以**管理员身份**运行（会弹一次 UAC）。
 * 结果写到 .logs/hosts-result.txt，好让发起方能读到结果。
 */
const fs = require('node:fs');
const path = require('node:path');

const HOSTS = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
const OUT = path.join(__dirname, '..', '.logs', 'hosts-result.txt');

function report(lines) {
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
  } catch {}
  try {
    fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  } catch {}
  console.log(lines.join('\n'));
}

try {
  const raw = fs.readFileSync(HOSTS, 'utf8');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const bak = HOSTS + '.bak-' + stamp;

  // 先备份 —— 万一删错了还能还原
  fs.writeFileSync(bak, raw);

  const src = raw.split(/\r?\n/);
  const removed = [];
  const kept = [];
  for (const l of src) {
    if (/github/i.test(l)) removed.push(l.trim());
    else kept.push(l);
  }

  fs.writeFileSync(HOSTS, kept.join('\r\n'), 'utf8');

  report([
    '结果: 成功',
    '备份: ' + bak,
    '删除行数: ' + removed.length,
    '删除内容:',
    ...removed.map((l) => '  - ' + l),
    '剩余有效行: ' + kept.filter((l) => l.trim()).length,
  ]);
} catch (e) {
  report(['结果: 失败', '错误: ' + e.message, 'code: ' + (e.code || '')]);
  process.exitCode = 1;
}
