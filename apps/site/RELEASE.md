# 发布清单 · 下载页

每次发新版照着走一遍。前三项是必须的，后面的按情况。

---

## 1. 打包安装包

```powershell
cd apps/desktop

# 第一次需要先装 electron-builder（它不在原依赖里，是本次为打包新增的）
pnpm install

# 出 NSIS 安装包 → dist/MusicPlayer-0.1.0-Setup.exe
npm run dist

# 只想快速试打包（出解压目录，不起安装器，快很多）
npm run dist:dir
```

> 首次 `dist` 会联网下载 NSIS 工具链和签名辅助程序，几百 MB，慢是正常的。

### ⚠️ 国内网络：先确认下载源

打包时 electron-builder 要从 GitHub Releases 拉 **electron 二进制（约 150 MB）**
和 nsis / winCodeSign。国内直连经常超时，而且**失败会伪装成别的错**：

```
⨯ downloadArtifact ... electron-v42.11.3-win32-x64.zip
  read tcp ...: connection attempt failed ... connected host has failed to respond

app-builder.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
```

第二条是第一条的下游表现 —— 下载正是 app-builder 干的活，下载失败它就非零
退出。看起来像"可执行文件坏了"，实际是网络问题。排查时先看日志里有没有
`downloadArtifact` / `read tcp` / `connection attempt failed`。

`build-installer.ps1` 默认已经指向 npmmirror 镜像，不用手动配。想让所有终端
都生效：

```powershell
powershell -File tools/setup-cn-mirrors.ps1 -Persist
```

镜像也不通的话，见 `apps/site/DEPLOY.md` 里"没有网络怎么办"一节。

### 不用启动就能做的自检

```powershell
# 在仓库根目录执行，检查 dist:dir 的产物
powershell -File tools/check-package.ps1
```

它会直接读 `app.asar` 的头部，检查：

- 主程序和 `resources/ui/index.html` 在不在（缺了就是白屏）
- 界面关键文件齐不齐（`main.js` / `particles.js` / `three.module.js`）
- `@dsh/music-core` 及其 **6 个运行时依赖**有没有打进包
  （junction 链接最容易漏，漏了启动即崩）
- 包里有没有混进 `.session.json` 或日志

### ⚠️ 打包后必须实测这两点

1. **装完之后能正常起界面。** `apps/ui` 是作为 `extraResources` 放到
   `resources/ui` 的，代码里靠 `app.isPackaged` 切换路径（见 `main.js` 的
   `UI_ROOT`）。路径算错的表现是**白屏**——窗口出来了但 `app://` 全部 404。
   如果白屏，先确认 `resources/ui/index.html` 是否存在。

2. **音源能跑。** `@dsh/music-core` 是指向仓库里 `packages/core` 的
   **junction 链接**，electron-builder 对软链接依赖的收集是最容易出问题的地方。
   一旦它没把 `packages/core/node_modules`（axios / crypto-js / node-forge /
   pako / qrcode / big-integer）一起打进包，程序会在启动瞬间报
   `Cannot find module 'axios'` 之类的错。
   跑一次 `npm run dist:dir`，然后直接运行
   `dist/win-unpacked/MusicPlayer.exe` 就能验证——不必先装一遍。

**发布前自检：**
- [ ] 安装包能正常启动、退出、重启
- [ ] 重新启动后用户数据（登录态、歌单、设置）还在
- [ ] 安装包里**不含** Cookie / Token / `.session.json` / 本机日志 / 缓存
- [ ] 在干净的 Windows 环境（或新用户账户）里装一遍，确认不依赖开发机的环境

---

## 2. 算校验值

```powershell
$f = Get-Item .\dist\MusicPlayer-0.1.0-Setup.exe
"文件名 : $($f.Name)"
"大小   : {0:N1} MB" -f ($f.Length / 1MB)
"SHA256 : $((Get-FileHash $f -Algorithm SHA256).Hash.ToLower())"
```

三行都记下来，等会儿要填进配置。

---

## 3. 上传并更新配置

### 3.1 覆盖 R2 上的安装包

路径**保持** `latest/MusicPlayer-Setup.exe` 不变：

```bash
npx wrangler r2 object put music-player-downloads/latest/MusicPlayer-Setup.exe \
  --file="apps/desktop/dist/MusicPlayer-0.1.0-Setup.exe" \
  --content-type="application/octet-stream"
```

想留档就再传一份到 `archive/<版本>/`。

- [ ] 浏览器直接打开 R2 地址，确认是**下载**而不是在页面里显示内容
- [ ] 下载下来的文件能正常运行

### 3.2 更新 `apps/site/site.config.json`

- [ ] `release.version` 改成新版本号
- [ ] `release.releaseDate` 改成发布日期
- [ ] `release.fileSize` 填上一步算出来的大小
- [ ] `release.sha256` 填上一步算出来的校验值
- [ ] `release.channel` / `channelLabel` 按情况改（内测版 / 正式版）
- [ ] `changelog` 数组**开头**插入新版本记录
- [ ] 功能有变化时同步更新 `features`

---

## 4. 本地验证

```bash
node apps/site/.preview-server.cjs
```

浏览器打开 `http://127.0.0.1:5180`：

- [ ] 下载按钮可点击，点下去真的开始下载
- [ ] 下载到的文件大小和页面上写的一致
- [ ] 页面上的版本号 = 安装包的实际版本
- [ ] `F12` 控制台没有红色报错

跑一遍自动检查，确认没有回归：

```bash
node .probe/site-dom/verify-site.cjs
node .probe/site-dom/verify-published.cjs
```

---

## 5. 部署

```powershell
# 生成暂存目录（会做上线前校验）
powershell -File apps/site/tools/stage-deploy.ps1
```

```bash
npx wrangler pages deploy .tmpcheck/site-deploy --project-name=music-player-download
```

- [ ] 暂存脚本的所有校验项都是 ✓
- [ ] 部署命令返回成功

---

## 6. 线上验收

打开正式域名：

- [ ] 版本号是**新的**（如果还是旧的，见下面「缓存」）
- [ ] 下载按钮 → 文件能下下来
- [ ] 文件 SHA-256 和页面上写的一致：

  ```powershell
  (Get-FileHash .\MusicPlayer-0.1.0-Setup.exe -Algorithm SHA256).Hash.ToLower()
  ```

- [ ] 更新日志里能看到这一版
- [ ] 手机上打开布局正常
- [ ] 固定短链（如果配了）也指向新文件

### 缓存

配置文件的响应头是 `no-cache`，正常情况下改完立刻生效。
如果线上还是旧版本号：

```bash
curl -I https://你的域名/site.config.json
```

看 `cache-control` 是不是 `no-cache`。不是的话说明 `_headers` 没部署上去，
重新跑一次第 5 步。

---

## 7. 收尾

- [ ] 更新仓库 README 里的版本号（如果里面写了）
- [ ] 需要的话在 GitHub 打 tag：`git tag v0.1.0 && git push origin v0.1.0`
- [ ] 如果这个版本要同时发到网盘（夸克 / 百度云），把链接填进
      `site.config.json` 的 `release.mirrors`，页面上会显示成「备用线路」
- [ ] 在 GitHub Issues 里同步一下这版修了什么

---

## 回滚

出问题就把 `site.config.json` 改回上一版并重新部署 —— 页面本身就回滚了。
安装包因为路径固定，需要把旧版 exe 重新上传覆盖 `latest/`。

所以**归档目录很有用**：留着 `archive/<版本>/` 才能在紧急时快速还原。
