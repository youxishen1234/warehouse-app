#!/bin/bash
# ============================================================
# 曙光仓库 App - HTTPS 服务器一键部署脚本（Ubuntu / Debian）
# 服务器: 152.136.100.200
# 后端服务: http://127.0.0.1:4000
#
# 使用方法：
#   1. 先把域名 A 记录解析到 152.136.100.200
#   2. 修改下面的 DOMAIN 变量为你的实际域名
#   3. 上传本脚本到服务器，执行: sudo bash setup-https.sh
# ============================================================

set -e

# ====== 配置区（请修改）======
DOMAIN="youxishen.online"          # 你的域名
EMAIL="admin@youxishen.online"     # 你的邮箱（用于 Let's Encrypt 到期提醒）
BACKEND_PORT="4000"              # 后端服务端口
# ==============================

echo "=========================================="
echo "  曙光 App HTTPS 部署脚本"
echo "  域名: $DOMAIN"
echo "  后端: http://127.0.0.1:$BACKEND_PORT"
echo "=========================================="

# 1. 检查是否 root
if [ "$EUID" -ne 0 ]; then
    echo "请用 sudo 运行本脚本"
    exit 1
fi

# 2. 安装 Nginx 和 certbot
echo "[1/6] 安装 Nginx 和 certbot..."
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx

# 3. 配置防火墙
echo "[2/6] 配置防火墙（开放 80 和 443）..."
if command -v ufw &> /dev/null; then
    ufw allow 'Nginx Full'
    ufw allow 80/tcp
    ufw allow 443/tcp
    echo "  ufw 已配置"
fi
# 云服务器还需要在控制台安全组里放行 80 和 443
echo "  ⚠️ 如果是云服务器，请在控制台安全组里也放行 80 和 443 端口"

# 4. 创建 certbot 验证目录
echo "[3/6] 创建 certbot 验证目录..."
mkdir -p /var/www/certbot

# 5. 申请 Let's Encrypt 证书
echo "[4/6] 申请 Let's Encrypt SSL 证书..."
certbot certonly \
    --webroot \
    -w /var/www/certbot \
    -d "$DOMAIN" \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    --non-interactive

if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    echo "❌ 证书申请失败，请检查域名解析和 80 端口是否可达"
    exit 1
fi
echo "  ✅ 证书申请成功"

# 6. 生成 Nginx 配置
echo "[5/6] 生成 Nginx 配置..."
cat > /etc/nginx/sites-available/warehouse-app << NGINX_CONF
# HTTP 80：跳转 HTTPS + certbot 验证
server {
    listen 80;
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS 443：反向代理到后端
server {
    listen 443 ssl;
    http2 on;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;

    client_max_body_size 500m;
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:$BACKEND_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX_CONF

# 启用站点
ln -sf /etc/nginx/sites-available/warehouse-app /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# 7. 测试并重启 Nginx
echo "[6/6] 测试 Nginx 配置并重启..."
nginx -t
systemctl reload nginx
systemctl enable nginx

echo ""
echo "=========================================="
echo "  ✅ HTTPS 部署完成！"
echo "=========================================="
echo "  访问地址: https://$DOMAIN"
echo "  证书路径: /etc/letsencrypt/live/$DOMAIN/"
echo "  Nginx 配置: /etc/nginx/sites-available/warehouse-app"
echo ""
echo "  接下来需要修改 App 端热更新地址："
echo "  把 https://152.136.100.200 改为 https://$DOMAIN"
echo "  （在 www/index.html 第24行和第29行）"
echo ""
echo "  证书自动续期：certbot 已配置定时任务，无需手动操作"
echo "=========================================="
