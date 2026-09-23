# 曙光 App - HTTPS 热更新服务器部署指南

## 问题背景

代码里热更新地址已改为 `https://152.136.100.200`，但服务器实际探测结果：

| 端口 | 状态 |
|---|---|
| 80 (HTTP) | ✅ 开着 |
| 4000 | ✅ 开着（后端服务） |
| 443 (HTTPS) | ❌ 没开 |

所以 App 端热更新会因为连不上 443 而失败。

## 解决方案

用 **Nginx 反向代理 + Let's Encrypt 免费证书**，把 HTTPS 请求转发到后端 4000 端口。

> ⚠️ Let's Encrypt 不支持 IP 地址证书，必须用域名。

## 部署步骤

### 1. 准备域名

- 买一个域名（或用已有域名的子域名，例如 `update.example.com`）
- 添加 A 记录，解析到 `152.136.100.200`
- 等待 DNS 生效（通常几分钟）

### 2. 云服务器安全组放行

在云服务商控制台的安全组里，放行 **80** 和 **443** 端口的入站规则。

### 3. 上传并运行部署脚本

```bash
# 上传 setup-https.sh 到服务器
scp setup-https.sh root@152.136.100.200:/root/

# SSH 登录服务器
ssh root@152.136.100.200

# 修改脚本里的 DOMAIN 和 EMAIL 变量
vim /root/setup-https.sh

# 运行脚本
sudo bash /root/setup-https.sh
```

脚本会自动完成：
- 安装 Nginx + certbot
- 配置防火墙
- 申请 Let's Encrypt SSL 证书
- 生成 Nginx 反向代理配置
- 重启 Nginx

### 4. 修改 App 端热更新地址

部署成功后，把 App 里的热更新地址从 IP 改为域名：

文件：`www/index.html`
- 第 24 行：`c = 'https://152.136.100.200';` → 改为 `c = 'https://你的域名';`
- 第 29 行：`return 'https://152.136.100.200/';` → 改为 `return 'https://你的域名/';`

然后重新 `npx cap sync` 并打包。

## 文件说明

| 文件 | 用途 |
|---|---|
| `setup-https.sh` | 服务器一键部署脚本（Ubuntu/Debian） |
| `nginx.conf` | Nginx 配置参考（手动部署时用） |
| `README.md` | 本说明文档 |

## 验证

部署完成后，在本地测试：

```bash
# 测试 HTTPS 是否通
curl -I https://你的域名/

# 查看证书信息
curl -vI https://你的域名/ 2>&1 | grep -E "SSL|certificate|subject|expire"
```

## 证书续期

Let's Encrypt 证书有效期 90 天，certbot 会自动配置 systemd timer 续期，无需手动操作。可通过以下命令检查：

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

## 常见问题

**Q: 证书申请失败？**
A: 检查域名是否已解析到服务器 IP，80 端口是否可达（安全组 + 防火墙都要放行）。

**Q: 不想用域名，能用 IP 直签证书吗？**
A: 可以用 ZeroSSL 或 SSL.com 签 IP 证书，但部分旧 Android 设备可能不信任。推荐用域名方案。

**Q: 后端服务不是 4000 端口？**
A: 修改 `setup-https.sh` 里的 `BACKEND_PORT` 变量，或修改 nginx.conf 里的 `proxy_pass` 端口。
