# 部署手册 · Cloudflare Pages + R2

从零开始把下载页跑起来，按顺序做就行。全程在 Cloudflare 免费额度内。

**你需要准备的：**
- 一个 Cloudflare 账号（免费）
- 一个已打包好的 `MusicPlayer-x.y.z-Setup.exe`

**全程只有两个东西要创建：** 一个 R2 存储桶（放安装包）、一个 Pages 项目（放网页）。

---

## 第一步：安装包放上 R2

### 1.1 创建存储桶

Cloudflare 面板 → 左侧 **R2** → **Create bucket**。

- 名称：`music-player-downloads`（名字随便，但下面命令里的名字要和它一致）
- 位置：默认即可（`Automatic`）

> 首次进 R2 会要求绑定支付方式。免费额度是 **10 GB 存储 / 每月 100 万次写入 /
> 1000 万次读取**，[出流量完全不收费](https://developers.cloudflare.com/r2/pricing/)。
> 一个 100 MB 的安装包 + 每月一万次下载，离超限还很远。

### 1.2 开启公开访问

进桶 → **Settings** → **Public access** → 点 **R2.dev subdomain** 的 **Allow Access**。

会得到一个形如 `https://pub-xxxxxxxxxxxx.r2.dev` 的地址，**记下来，下一步要用**。

> ⚠️ `r2.dev` 域名按 Cloudflare 的说法是给开发测试用的，
> [生产环境建议绑自定义域名](https://developers.cloudflare.com/r2/buckets/public-buckets/)：
> 在同一个 Settings 页面的 **Custom Domains** → **Connect Domain**，
> 填一个你已有的域名（比如 `dl.你的域名.com`）。好处是能吃到 CDN 缓存、
> 国内访问也更稳。不绑也能用，只是慢一点。

### 1.3 上传安装包

**关键：文件名固定成 `latest/MusicPlayer-Setup.exe`，路径里不要出现版本号。**

这样以后发新版直接覆盖同名文件，下载链接永远不用改。

**方式 A：面板上传（不需要命令行）**

进桶 → **Upload** → 选择你的 exe → 上传完成后，路径要改成 `latest/MusicPlayer-Setup.exe`。
面板上传是平铺的，改路径的办法是先传好再 **Rename**，或者直接用方式 B。

**方式 B：wrangler 命令行（推荐，路径可控）**

```bash
npx wrangler login
npx wrangler r2 object put music-player-downloads/latest/MusicPlayer-Setup.exe \
  --file="dist/MusicPlayer-0.1.0-Setup.exe" \
  --content-type="application/octet-stream"
```

> `--content-type` 要显式指定。不给的话 R2 可能猜成错的类型，
> 有些浏览器会直接把 exe 当文本显示而不是下载。

### 1.4 验证安装包真的能下

浏览器打开（换成你自己的 r2.dev 地址）：

```
https://pub-xxxxxxxxxxxx.r2.dev/latest/MusicPlayer-Setup.exe
```

应该**立刻开始下载**。如果显示的是文件内容或者报错，说明上一步的
`--content-type` 或文件路径不对，回 1.3 重做。

---

## 第二步：下载页部署到 Pages

### 2.1 填好配置

打开 `apps/site/site.config.json`，至少改这三项：

```json
"release": {
  "version": "0.1.0",
  "releaseDate": "2025-01-01",
  "fileSize": "112.4 MB",
  "sha256": "a3f1c9e0...",
  "downloads": {
    "windows": "https://pub-xxxxxxxxxxxx.r2.dev/latest/MusicPlayer-Setup.exe"
  }
}
```

`sha256` 和 `fileSize` 这样生成（在 exe 所在目录）：

```powershell
$f = Get-Item .\MusicPlayer-0.1.0-Setup.exe
"{0:N1} MB" -f ($f.Length / 1MB)
(Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
```

> 页面对占位符有保护：配置里还写着 `待填写` 或 `REPLACE` 时，
> 下载按钮会显示「安装包未发布」且不可点击，不会把访客引到一个坏链接。
> 所以你可以在安装包还没传好之前就先把页面部署上去。

### 2.2 本地确认

```bash
node apps/site/.preview-server.cjs
# 打开 http://127.0.0.1:5180 检查一遍
```

重点看：下载按钮能不能点、点下去是不是真的开始下载、
版本号 / 大小 / 校验值和 exe 是否一致。

### 2.3 创建 Pages 项目并上传

**推荐做法：先生成一个"只有站点文件"的暂存目录再部署。**

`apps/site` 里混着文档和工具脚本，直接 `deploy .` 有把它们一起传上线的风险。
本目录下的 `.assetsignore` 会尝试排除这些文件，但该机制在不同 wrangler 版本上
行为不完全一致，所以别把安全性押在它身上 —— 用暂存目录最保险。

脚本会按白名单复制，并顺手做几项校验（无多余文件、JSON 合法、无空文件、
下载链接是不是还是占位符）：

```powershell
# 在仓库根目录执行
powershell -File apps/site/tools/stage-deploy.ps1
```

输出类似：

```
✓ 无多余文件（文档与工具脚本均未混入）
✓ site.config.json 是合法 JSON
✓ 无空文件
暂存目录就绪，共 13 个文件 / 1,136 KB
```

确认没问题就部署：

```bash
npx wrangler pages deploy .tmpcheck/site-deploy --project-name=music-player-download
```

首次执行会让你登录并自动创建项目，结束后会打印一个
`https://music-player-download.pages.dev` 的地址。

**方式 B：面板拖拽（不想装 node 就用这个）**

Cloudflare 面板 → **Workers & Pages** → **Create** → **Pages** →
**Upload assets** → 项目名填 `music-player-download` → 把上面生成的
暂存目录 `.tmpcheck/site-deploy` 拖进去。

> 拖拽上传不会读 `.assetsignore`，所以**必须拖暂存目录**，
> 不能直接拖 `apps/site`。
>
> `_headers` 和 `_redirects` 是 Pages 的约定文件名，放在根目录就会被识别，
> 两种上传方式都支持。

**方式 C：Git 集成（想自动发版再用）**

把仓库连到 Pages 项目，构建设置留空、输出目录填 `apps/site`。
缺点是 Pages 会按 `.gitignore` 而不是 `.assetsignore` 来筛文件，
文档还是可能被带上；要彻底干净就得配一条构建命令把文件拷到输出目录。

### 2.4 验证

打开分配到的 `*.pages.dev` 地址，逐项确认：

- [ ] 页面正常渲染，深色 + 金色，粒子背景在动
- [ ] 版本信息卡里的版本号、大小、日期都对
- [ ] 点「下载 Windows 版」→ 真的开始下载安装包
- [ ] 复制按钮能复制 SHA-256
- [ ] 浏览器控制台（F12）没有报错
- [ ] 手机上打开看一眼，布局没崩

如果页面空白，先看控制台：多半是 `site.config.json` 没传上去，
或者 JSON 格式写坏了（页面右下角会弹一个红色提示框说明原因）。

---

## 第三步（可选）：绑自己的域名

Pages 项目 → **Custom domains** → **Set up a custom domain** → 填域名。

如果域名已经托管在 Cloudflare，会自动加好 DNS 记录；否则按提示去你的
DNS 服务商加一条 CNAME。证书是自动签发的，通常几分钟内生效。

### 顺便做一条固定下载短链

想让 `你的域名.com/dl/latest` 也指向安装包（这样对外只需要给一个短地址）：

**做法一：改 `_redirects` 文件**

打开 `apps/site/_redirects`，取消那一行的注释并改成你的真实地址：

```
/dl/latest    https://pub-xxxxxxxxxxxx.r2.dev/latest/MusicPlayer-Setup.exe    302
```

**做法二：用 Cloudflare 的 Redirect Rules（不用重新部署）**

面板 → 你的域名 → **Rules** → **Redirect Rules** → 新建：
- 匹配：`URI Path equals /dl/latest`
- 目标：你的 R2 地址
- 状态码：302

两种做法选一个就行，**不要同时用**，否则两条规则会打架。
用了做法二就把 `_redirects` 里那行保持注释状态。

### 建议顺手开的设置

- **SSL/TLS → Edge Certificates → Always Use HTTPS**：打开，强制跳 HTTPS
- **Speed → Optimization → Brotli**：打开，HTML/CSS/JS 再小一截

---

## 日常维护

### 发一个新版本

1. 本地打包出新 exe
2. 上传覆盖 R2 里的 `latest/MusicPlayer-Setup.exe`（路径不变）
3. 改 `site.config.json`：`version` / `releaseDate` / `fileSize` / `sha256`，
   并在 `changelog` 数组开头插一条新记录
4. 重跑 `powershell -File apps/site/tools/stage-deploy.ps1` 并重新部署
5. 刷新页面确认

下载链接一次都不用改，因为路径是固定名。完整清单见 [`RELEASE.md`](./RELEASE.md)。

### 想保留历史版本

除了 `latest/`，再往桶里传一份带版本号的：

```
latest/MusicPlayer-Setup.exe          ← 页面下载按钮指向这里
archive/0.1.0/MusicPlayer-Setup.exe   ← 归档，需要时手动指过去
```

### 缓存问题排查

如果你改了 `site.config.json` 但页面上还是旧版本号：

```bash
curl -I https://你的域名/site.config.json
```

看返回头里是不是 `cache-control: no-cache`。`_headers` 里已经给它单独设了
不缓存，如果线上不是这个值，说明 `_headers` 没跟着部署上去。

---

## 没有网络怎么办（或 GitHub 一直超时）

打包需要从 GitHub 拉 electron 二进制，约 150 MB。国内直连常失败，而且报错会
伪装成 `app-builder.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`
（下载是 app-builder 干的活）。三条路，按推荐顺序：

### 1. 用镜像（首选）

```powershell
powershell -File tools/setup-cn-mirrors.ps1 -Persist
```

写三个用户级环境变量，指向 npmmirror。打完包想还原就把它们删掉。

### 2. 用本地已有的 Electron 缓存

Electron 的二进制缓存在 `%LOCALAPPDATA%\electron\Cache\`。如果那里已经有一个
**完整**的 `electron-v<版本>-win32-x64.zip`，把 `apps/desktop/package.json` 的
electron 依赖改成那个版本，就不需要下载了：

```powershell
# 先看缓存里有什么版本
Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Filter 'electron-v*.zip' |
  Format-Table Name, @{n='MB';e={[math]::Round($_.Length/1MB)}}
```

⚠️ 这等于**升级 Electron 大版本**（例如从 42 换到 44），必须实测：
装完先跑 `dist\win-unpacked\MusicPlayer.exe`，确认界面、播放、粒子效果都正常，
再决定是否发布。不要只看"打包成功"就发。

⚠️ 缓存目录里那些 `*.part*` 文件是**失败下载的残渣**，不是可用的包，别拿它们顶。

### 3. 挂代理

配置 `HTTPS_PROXY` 环境变量后重跑，或者用能直连 GitHub 的网络环境打一次包，
之后 `dist\win-unpacked` 可以整个拷到别的机器上用。

---
## 常见问题

**Q：为什么安装包不直接放 Pages 里？**
Pages 静态资源单文件上限 25 MiB，Electron 安装包远超这个数，上传会直接失败。
也不要提交到 Git 仓库：GitHub 单文件超过 100 MB 会被拒收，50 MB 就告警。

**Q：R2 会不会产生费用？**
10 GB 存储以内、每月 100 万次写入 / 1000 万次读取以内免费，且出流量（下载）
不收费。这是 R2 相比 S3 / 对象存储最主要的差别。

**Q：访问速度慢怎么办？**
`r2.dev` 域名没有 CDN 优化。绑一个自定义域名能明显改善，尤其是国内访问。

**Q：能不能让它自动发版？**
可以：把 `apps/site` 放进 GitHub 仓库，用 Cloudflare Pages 的 Git 集成
（连接仓库后推代码自动部署），再加一个 GitHub Actions 在打 tag 时
用 wrangler 上传安装包到 R2。等你需要频繁发版时再做，现在手动三步更省事。
