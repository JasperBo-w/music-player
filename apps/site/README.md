# 音乐播放器 · 下载页

一个纯静态的软件下载页，部署在 Cloudflare Pages 上。安装包本体放在 Cloudflare R2，
页面只负责展示版本信息和把用户引到下载链接。

用这套组合的原因很简单：**Cloudflare Pages 的静态资源有单文件 25 MiB 上限**
（见 [Pages Limits](https://developers.cloudflare.com/pages/platform/limits/)），
而 Electron 的安装包通常 80–150 MB，根本传不上去。R2 则没有这个限制，
而且[出流量免费](https://developers.cloudflare.com/r2/pricing/)。

```
下载页 (Cloudflare Pages)  ────▶  安装包 (Cloudflare R2)
   HTML / CSS / JS                     MusicPlayer-Setup.exe
   ~40 KB 代码                         100 MB+
```

## 目录结构

```
apps/site/
├── index.html                  页面骨架（只有一次性的静态结构，没有硬编码的产品信息）
├── styles.css                  全部视觉：主题令牌 + HUD 风格组件
├── app.js                      读取配置渲染页面 + 粒子背景 + 交互
├── site.config.json            ★ 唯一需要维护的数据文件
├── _headers                    Pages 响应头（缓存策略、安全头）
├── _redirects                  Pages 重定向（固定下载短链）
├── .assetsignore               部署排除清单（见「已知取舍」里的说明）
├── wrangler.toml               Pages 项目定义（名字、输出目录）
├── robots.txt
├── assets/
│   └── favicon.svg             站点图标
└── tools/
    └── stage-deploy.ps1        生成部署用暂存目录（含上线前校验）
```

> 截图处理脚本在仓库根的 `tools/make-site-shots.ps1`（它要处理你本机截的图，
> 不属于站点目录，所以没放在这里）。

**核心约定：不要改 HTML 里的文案。** 所有产品信息（版本号、大小、校验值、
功能列表、FAQ、更新日志）都从 `site.config.json` 读取。发新版只需要改这一个文件。

## 本地预览

```bash
node apps/site/.preview-server.cjs
# 打开 http://127.0.0.1:5180
```

这个服务器模拟了 Pages 的几个行为（目录回落到 index.html、未知路径兜底回首页、
按扩展名给 MIME），所以本地看到的效果和线上基本一致。

### 渲染验证

改完 `app.js` 或 `site.config.json` 之后想确认没写坏：

```bash
node .probe/site-dom/verify-site.cjs       # 占位符状态（当前状态）
node .probe/site-dom/verify-published.cjs  # 已填真实链接的发布状态
```

这两个脚本用 jsdom 在真实 DOM 里执行 `app.js`，检查配置有没有正确渲染进页面、
有没有 JS 报错、占位符有没有泄露到页面上。需要先装依赖：

```bash
cd .probe/site-dom && npm install jsdom
```

## 截图（当前为空）

页面上**没有放截图**，`site.config.json` 里的 `screenshots` 是空数组，
截图那一整段会自动隐藏。

原因是 `.shots-effects/` 里那些图都是开发过程调试用的，混着登录态和大量
「改到一半」的中间状态，不适合当产品截图。**产品截图应当专门截一次。**

### 怎么加截图

1. 打开软件自己截几张（建议宽 1600px 以上、16:10 左右）
2. 先 DryRun 确认遮盖框位置（会生成一张带红框的预览图）：

```powershell
powershell -File tools/make-site-shots.ps1 -Shot .\shot1.png,.\shot2.png -DryRun
```

3. 打开 `apps/site/assets/screenshots/DRYRUN-*.png` 看一眼红框有没有框住
   侧栏左下角的账号信息。位置对就正式跑：

```powershell
powershell -File tools/make-site-shots.ps1 -Shot .\shot1.png,.\shot2.png
```

4. 把脚本打印的 `screenshots` 数组填进 `apps/site/site.config.json`，
   `caption` 自己写一句说明（脚本故意留空）

工具会自动做三件事：遮盖账号信息、缩到 1600px 宽、转 JPEG（体积约降 85%）。
如果截的是未登录状态，加 `-NoRedact` 跳过遮盖。

> 遮盖区域按 1860×1203 标定，会按实际尺寸等比换算，窗口比例接近就能对上。
> 窗口特别窄的话先用 `-DryRun` 确认。

体积参考：1600px 宽的 JPEG 每张约 240 KB。没有截图时整个站点只有约 73 KB。

## 部署

见 [`DEPLOY.md`](./DEPLOY.md)，逐步操作说明都在里面。要点只有一个：
**不要直接 `deploy apps/site`，而是先复制出一份只含站点文件的暂存目录再部署**
（`DEPLOY.md` 2.3 给了现成的复制命令），免得把文档和工具脚本一起传上线。

每次发版的检查清单见 [`RELEASE.md`](./RELEASE.md)。

## 设计说明

视觉上刻意和播放器本体保持同一套语言，而不是做一个通用的落地页：

| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg` | `#08090B` | 深空底色，与 `apps/ui/src/styles.css` 同值 |
| `--accent` | `#E8C87A` | 香槟金强调色，与播放器一致 |
| `--violet` | `#7C5CFF` | 紫罗兰副光 |
| `--ice` | `#8FE9FF` | 冰蓝点缀（少量冷色粒子） |
| `--font-mono` | JetBrains Mono 栈 | 所有标签、版本号、校验值 |

在这一套令牌之上叠加了 HUD / 全息终端的表达：全息网格底纹、CRT 扫描线、
胶片噪点、卡片切角、四角装饰、等宽字体标签、编号章节头、粒子星座背景。

想让科技感更强或更弱，改 `:root` 里的这几个参数就行，不用动具体样式：

```css
--grid-size:   52px;    /* 网格密度，调小更密 */
--grid-alpha:  .055;    /* 网格强度 */
--scan-alpha:  .022;    /* 扫描线强度，调到 0 就没有 CRT 味了 */
--noise-alpha: .03;     /* 胶片噪点 */
```

## 已知取舍

- **没有构建步骤。** 纯手写 HTML/CSS/JS，不需要 Vite / 打包器。
  好处是部署时传上去的就是最终产物，调试链路最短；
  代价是没有压缩混淆。这个体量（约 73 KB 未压缩）不值得为它引入构建链。
- **`.assetsignore` 不当作安全边界。** 它的作用是让 Pages 在打包阶段剔除
  `README.md` / `DEPLOY.md` / `tools/` 这类不该公开的文件，
  但不同 wrangler 版本对这个文件的支持程度不一致（本地环境不允许起
  子进程，没法实测）。所以部署走「先复制暂存目录」这条路，
  `.assetsignore` 只是第二道保险。
- **`og:image` 默认注释掉了。** 指向不存在的图片会让微信 / Twitter 的分享卡片
  变成空白。等你放了 `assets/og-cover.png`（建议 1200×630）再打开
  `index.html` 里那两行注释。
  ⚠️ 仓库的 `.gitignore` 有全局 `*.png` 规则，加这张图后要用
  `git add -f apps/site/assets/og-cover.png`，或者先在 `.gitignore` 里加白名单。
- **截图区是空的。** 见上面「截图」一节。想加回来时记得用 `-RedactAccount`，
  或者直接重新截一张未登录状态的界面。
