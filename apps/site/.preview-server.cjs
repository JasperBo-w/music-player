/*
 * 本地预览用的极简静态服务器 —— 只为了在部署前检查页面。
 * 不参与部署，可以随时删掉。
 *
 * 用法：node apps/site/.preview-server.cjs [端口]
 * 然后打开 http://127.0.0.1:5180
 *
 * 它刻意模拟 Cloudflare Pages 的几个行为，好让本地和线上表现一致：
 *   - 目录请求回落到 index.html
 *   - 未知路径也回 index.html（Pages 的 SPA 式兜底）
 *   - 未知扩展名按 application/octet-stream 返回
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || 5180);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let filePath = path.join(ROOT, urlPath);

  // 目录请求给 index.html
  if (urlPath.endsWith('/')) filePath = path.join(filePath, 'index.html');

  // 防目录穿越
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Pages 的兜底：找不到就回首页，而不是 404 白屏
      fs.readFile(path.join(ROOT, 'index.html'), (e2, home) => {
        if (e2) return res.writeHead(404).end('not found');
        res.writeHead(200, { 'Content-Type': TYPES['.html'] }).end(home);
      });
      return;
    }

    const type = TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // 和线上 _headers 的策略对齐：配置不缓存，HTML/JS/CSS 短缓存
    const cache = path.basename(filePath) === 'site.config.json'
      ? 'no-cache'
      : (['.html', '.js', '.css'].includes(path.extname(filePath)) ? 'max-age=300' : 'max-age=31536000');

    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache }).end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${PORT}`);
});
