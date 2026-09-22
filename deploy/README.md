# 下载页部署

本次只发布独立下载页和 Nginx 下载配置，不需要重建 IPA 或重启 Express。
当前工作区的 `www` 比线上 IPA/热更新包旧，不能用整个 `www` 覆盖线上。
现有 push 工作流会重打包 IPA、发布热更新；在同步最新前端之前，不要将这个旧工作区直接推到触发发布的 main/master 分支。

## 1. 生成下载文件

在此工作区运行（Node.js 22 或以上）：

```powershell
npm.cmd ci
curl.exe -fSL https://youxishen.online/shuguang.ipa -o "$env:TEMP/shuguang-download.ipa"
npm.cmd run prepare:download -- "$env:TEMP/shuguang-download.ipa"
```

产物在 `release/download/`，包含 `index.html`、应用图标和 `ipa.json`。
版本、Build、最低 iOS 版本、文件大小、SHA-256 均从实际 IPA 获取。
以后替换 IPA 时，对同一个待发布 IPA 重新运行生成命令，并一起发布这三个下载页文件。
不要手填版本号。生成脚本不会修改 IPA，也不会覆盖业务页面。

## 2. 上传到 Ubuntu

将 `用户名` 替换为已有 SSH 登录用户名，在工作区运行：

```powershell
scp -r release/download 用户名@152.136.100.200:/tmp/shuguang-download-page
scp deploy/nginx-download.conf 用户名@152.136.100.200:/tmp/shuguang-nginx-download.conf
```

登录服务器后执行：

```bash
sudo mkdir -p /opt/shuguang/public/download /etc/nginx/snippets
if [ -d /opt/shuguang/public/download ]; then
  sudo cp -a /opt/shuguang/public/download "/opt/shuguang/public/download.backup.$(date +%Y%m%d%H%M%S)"
fi
sudo install -m 644 /tmp/shuguang-download-page/index.html /opt/shuguang/public/download/index.html
sudo install -m 644 /tmp/shuguang-download-page/ipa.json /opt/shuguang/public/download/ipa.json
sudo install -m 644 /tmp/shuguang-download-page/app-icon.png /opt/shuguang/public/download/app-icon.png
sudo install -m 644 /tmp/shuguang-nginx-download.conf /etc/nginx/snippets/shuguang-download.conf
sudo stat /opt/shuguang/public/shuguang.ipa
```

`/opt/shuguang/public` 来自仓库已有 iOS 上传工作流。若 `stat` 找不到文件，先将配置中的 root/alias 调整为实际公开文件目录。

## 3. 接入现有 Nginx 站点

使用 `sudo nginx -T` 在服务器本地查看配置，定位 `server_name youxishen.online` 的 HTTPS `server` 块，先备份该配置文件，再在块内加入：

```nginx
include /etc/nginx/snippets/shuguang-download.conf;
```

片段不能直接放到 `http` 层。若已经有同名的 `/shuguang.ipa`、`/download` 或 `/download/` location，应合并或替换对应规则，避免重复 location。
现有 TLS、API 和根目录配置继续使用原站点配置。如果 server 层有安全响应头，也应将所需头配置纳入这些 location，因为 Nginx 1.24 的 location add_header 不继承父层 add_header。

本片段直接由 Nginx 提供 IPA，避免和 Express 的附件头重复；不在 404 响应中附加下载头。

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -I https://youxishen.online/shuguang.ipa
curl -I https://youxishen.online/download
curl -fsS https://youxishen.online/download/ipa.json
```

IPA 应返回 `200`、`Content-Disposition: attachment; filename="shuguang.ipa"`。
下载页应返回 `200`、`text/html`。分享地址为 `https://youxishen.online/download`。
不需要 `itms-services`。用户下载后自行签名；附件头不能绕过微信等内置浏览器的下载限制。

## 本次核对结果（2026-09-11）

- 实测线上 `/shuguang.ipa` 已有 Express 返回的附件头；此前提供的“没有附件头”状态已发生变化。
- IPA：版本 `1.0`，Build `2`，最低 iOS `13.0`，5,186,594 字节。
- SHA-256：`f183389b54a83720e26249e844b0db0a273a85da0f6b1f629966c538ee5f1328`。
- 工作区与实际 IPA 的 Capacitor 配置均无 `server.url`，内置页面从 `public` 加载。
- 实际 IPA 的 `public/index.html` 引用 `js/app.3f37c41e.js`，其中存在供应商页面路由、结清确认、`settleCustomer` 和 `settleSupplier` 调用。
- 客户结清调用客户更新接口提交 `debt: 0`；供应商结清调用供应商更新接口提交 `payable: 0`。本次仅检查代码，没有执行真实账务写入，不能据此保证后端结清行为正确。
- 线上热更新 manifest 版本 `20260911120000` 的 `www.zip` 也包含上述页面和调用。
- 实际 IPA/热更新包启动脚本在通知启动成功后提前 return，自动检查路径被停用；工作区 `www/index.html` 则仍有启动自动更新路径。`autoUpdate: false` 单独不能说明自定义热更新是否运行。
- 当前工作区主包是 `app.04982b06.js`，与线上不一致；未在该工作区产物中找到完整供应商管理/结清实现。
- 这些证据证明前端功能代码已在当前下载 IPA 中；不证明某台手机当前运行的热更新版本或后端数据库状态。

## 本地验证

```powershell
$env:DOWNLOAD_PREVIEW_IPA = Join-Path $env:TEMP 'shuguang-download.ipa'
npm.cmd run test:download
npm.cmd run preview:download
```

预览地址：`http://127.0.0.1:4173/download`。首次在另一台电脑执行测试若缺浏览器，运行 `npx.cmd playwright install chromium webkit`。
测试覆盖桌面 Chromium、移动尺寸 WebKit 的信息显示、图标、横向溢出、真实文件下载哈希和元数据失败状态。仍需在实际 iPhone Safari/对方网络下验收。
Nginx 片段已用本地临时 Nginx 1.24.0 执行 `nginx -t` 验证通过；上线时仍须在 Ubuntu 上检查与现有站点配置的合并结果。

下载页相关依赖已安装。原项目 Capacitor 6 的 CLI/tar 依赖仍有 npm audit 报告的两项问题；此次未强制跨版本升级 Capacitor，以免改变原生工程兼容性。
Windows 无法安装 macOS 专用 Xcode 来构建 iOS；原仓库的 macOS CI 可用于后续构建，但应先同步最新业务前端。
