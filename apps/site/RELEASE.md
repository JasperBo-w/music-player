# 发布清单 · 下载页

每次发新版照着走一遍。前三项是必须的，后面的按情况。

---

## 1. 打包安装包

```powershell
cd apps/desktop
npm run build        # 或你实际用的打包命令
```

产出：`dist/MusicPlayer-<版本>-Setup.exe`

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
