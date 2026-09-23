# 曙光 App HTTPS 服务器部署指南（youxishen.online）

## 一、基本信息

- 域名：`youxishen.online`
- 服务器 IP：`152.136.100.200`
- 后端服务端口：`4000`（已在运行）
- Nginx 端口：`80`（跳转 HTTPS）、`443`（HTTPS 反向代理）
- SSL 证书：Let's Encrypt 免费证书（自动续期）
- App 端热更新地址：`https://youxishen.online`

## 二、部署步骤（按顺序执行）

### 第 1 步：域名解析（必须先做）

在域名控制台（你买域名的地方，比如阿里云/腾讯云/Namecheap）添加 DNS 记录：

| 记录类型 | 主机记录 | 记录值 | TTL |
|---|---|---|---|
| A | @ | 152.136.100.200 | 600 |
| A | www | 152.136.100.200 | 600 |

> `@` 表示根域名 `youxishen.online`，`www` 表示 `www.youxishen.online`。
> 添加后等几分钟生效，可以用 `ping youxishen.online` 验证是否解析到 152.136.100.200。

### 第 2 步：云服务器安全组放行端口

在云服务器控制台（阿里云/腾讯云等）的安全组里，放行以下入站规则：

| 端口 | 协议 | 来源 | 说明 |
|---|---|---|---|
| 80 | TCP | 0.0.0.0/0 | HTTP（用于 certbot 验证 + 跳转 HTTPS） |
| 443 | TCP | 0.0.0.0/0 | HTTPS（正式服务端口） |
| 4000 | TCP | 0.0.0.0/0 | 后端服务（如果之前已放行可跳过） |

> 如果服务器有防火墙（ufw/firewalld），也要放行：
> ```bash
> # Ubuntu/Debian
> sudo ufw allow 80/tcp
> sudo ufw allow 443/tcp
> ```

### 第 3 步：上传部署脚本到服务器

把 `setup-https.sh` 上传到服务器（用 scp 或 FTP 工具）：

```bash
# 本地执行（把脚本上传到服务器 /root/ 目录）
scp setup-https.sh root@152.136.100.200:/root/
```

### 第 4 步：SSH 登录服务器并执行脚本

```bash
# 登录服务器
ssh root@152.136.100.200

# 执行部署脚本（自动完成：装 Nginx + certbot + 签证书 + 配反向代理 + 重启 Nginx）
sudo bash /root/setup-https.sh
```

脚本会自动做以下事情：
1. 安装 Nginx 和 certbot
2. 配置防火墙
3. 申请 Let's Encrypt SSL 证书（域名 youxishen.online）
4. 生成 Nginx 配置（80 跳转 443，443 反向代理到 127.0.0.1:4000）
5. 重启 Nginx

> ⚠️ 执行前确保：域名已解析到服务器（第1步）+ 80 端口已放行（第2步），否则证书申请会失败。

### 第 5 步：上传热更新包和 APK

脚本执行成功后，把以下文件上传到服务器的静态文件目录：

| 本地文件 | 上传到服务器路径 |
|---|---|
| `bundle.zip` | 后端静态目录/appupdate/bundle.zip |
| `manifest.json` | 后端静态目录/appupdate/manifest.json |
| `app-release.apk` | 后端静态目录/apk/app-release.apk |

> 静态目录就是你后端服务存放静态文件的目录（比如 public/、static/、www/），根据你后端的实际情况放。

### 第 6 步：验证

```bash
# 1. 验证 HTTPS 可访问（应该返回 301 或 200）
curl -I https://youxishen.online

# 2. 验证证书有效
curl -vI https://youxishen.online 2>&1 | grep -E "SSL|subject|expire"

# 3. 验证热更新清单可访问
curl https://youxishen.online/appupdate/manifest.json

# 4. 验证热更新包可下载
curl -I https://youxishen.online/appupdate/bundle.zip

# 5. 验证 APK 可下载
curl -I https://youxishen.online/apk/app-release.apk
```

全部能访问就说明部署成功了。

## 三、App 端验证

1. 手机安装新的 `app-release.apk`（热更新地址已改成 `https://youxishen.online`）
2. 打开 App，启动时会自动检查热更新
3. 如果 `manifest.json` 里的 version 比当前版本新，会自动下载并更新

## 四、证书续期

Let's Encrypt 证书有效期 90 天，certbot 会自动配置定时任务续期，无需手动操作。可通过以下命令检查：

```bash
# 测试续期是否正常
sudo certbot renew --dry-run

# 查看定时任务
systemctl list-timers | grep certbot
```

## 五、常见问题

**Q: 证书申请失败？**
A: 检查两点：①域名是否已解析到 152.136.100.200（用 `ping youxishen.online` 验证）；②80 端口是否放行（安全组 + 防火墙都要放）。

**Q: 访问 HTTPS 显示 502 Bad Gateway？**
A: 说明 Nginx 起来了，但后端 4000 端口的服务没运行。启动你的后端服务即可。

**Q: 想同时支持 www.youxishen.online？**
A: 脚本里目前只签了根域名。如果需要 www，修改脚本里的 certbot 命令加上 `-d www.youxishen.online`，或者单独再签一个。

**Q: 后端服务不是 4000 端口？**
A: 修改 `setup-https.sh` 里的 `BACKEND_PORT` 变量，重新执行脚本。

## 六、快速检查清单

- [ ] 域名 youxishen.online 已解析到 152.136.100.200
- [ ] 云服务器安全组放行 80 和 443 端口
- [ ] 服务器防火墙放行 80 和 443
- [ ] setup-https.sh 已上传到服务器
- [ ] 脚本执行成功，证书申请通过
- [ ] Nginx 正常运行，HTTPS 可访问
- [ ] 热更新包 bundle.zip 已上传到 /appupdate/ 目录
- [ ] manifest.json 已上传到 /appupdate/ 目录
- [ ] APK 已上传到 /apk/ 目录
- [ ] 手机安装 APK 后能自动检测热更新
