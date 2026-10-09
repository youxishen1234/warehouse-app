#!/bin/sh
# Install in /etc/letsencrypt/renewal-hooks/deploy/ with mode 755.
# Load renewed certificates only after the current Nginx config validates.
set -eu
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
