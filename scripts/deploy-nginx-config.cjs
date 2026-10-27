'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const localConfig = path.join(root, 'deploy', 'nginx-production.conf');
const remoteConfig = process.env.WAREHOUSE_NGINX_CONFIG || '/etc/nginx/sites-available/shuguang';
const maxConfigBytes = 128 * 1024;

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

function validateConfig(config) {
  const text = Buffer.isBuffer(config) ? config.toString('utf8') : String(config || '');
  if (!text.trim() || Buffer.byteLength(text) > maxConfigBytes) throw new Error('Nginx production config is empty or too large');
  if (!text.includes('add_header X-Frame-Options DENY always;')) throw new Error('Normal routes must keep frame denial');
  const embed = text.match(/location \^~ \/embed\/ \{([\s\S]*?)\n    \}/)?.[1] || '';
  if (!embed) throw new Error('Embedded browser location is missing');
  if (!embed.includes("frame-ancestors 'self' app:")) throw new Error('Embedded browser policy must admit only the local app');
  if (/X-Frame-Options/i.test(embed)) throw new Error('Embedded browser location must not override the CSP with X-Frame-Options');
  return text;
}

function connection() {
  const host = process.env.HOTUPDATE_HOST;
  const user = process.env.HOTUPDATE_USER;
  const port = Number(process.env.HOTUPDATE_PORT || 22);
  if (!/^[A-Za-z0-9.-]+$/.test(host || '') || !/^[A-Za-z0-9_-]+$/.test(user || '')) {
    throw new Error('HOTUPDATE_HOST and HOTUPDATE_USER are required for Nginx publication');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port');
  if (!process.env.SSH_PRIVATE_KEY && !process.env.HOTUPDATE_PASSWORD) throw new Error('SSH_PRIVATE_KEY or HOTUPDATE_PASSWORD is required');
  return { target: `${user}@${host}`, port: String(port) };
}

function remoteCommand(command, args, options = {}) {
  const password = process.env.HOTUPDATE_PASSWORD;
  return execFileSync(password ? 'sshpass' : command, password ? ['-e', command, ...args] : args, {
    ...options,
    env: { ...process.env, ...(password ? { SSHPASS: password } : {}) },
    encoding: 'utf8'
  });
}

function ssh(command) {
  const target = connection();
  return remoteCommand('ssh', ['-p', target.port, '-o', 'ConnectTimeout=15', target.target, command], { maxBuffer: 8 * 1024 * 1024 });
}

function buildRemoteCommand(stage, config, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('Nginx config digest is invalid');
  return `set -eu
stage=${shellQuote(stage)}
config=${shellQuote(config)}
config_digest=${shellQuote(digest)}
backup="$(mktemp /tmp/shuguang-nginx-backup.XXXXXX)"
headers="$(mktemp)"
normal_headers="$(mktemp)"
had_config=0
cleanup() { rm -f -- "$stage/nginx-production.conf" "$backup" "$headers" "$normal_headers"; rmdir -- "$stage" 2>/dev/null || true; }
rollback() {
  if [ "$had_config" -eq 1 ]; then
    sudo -n cp -p -- "$backup" "$config"
    sudo -n nginx -t >/dev/null 2>&1 || true
    sudo -n systemctl reload nginx >/dev/null 2>&1 || true
  else
    sudo -n rm -f -- "$config"
  fi
}
verify_headers() {
  curl -fsSkI --resolve youxishen.online:443:127.0.0.1 https://youxishen.online/embed/pages/label-print/index > "$headers"
  grep -qi '^content-security-policy:.*frame-ancestors .*app:' "$headers"
  ! grep -qi '^x-frame-options:' "$headers"
  curl -fsSkI --resolve youxishen.online:443:127.0.0.1 https://youxishen.online/pages/label-print/index > "$normal_headers"
  grep -qi '^x-frame-options: DENY' "$normal_headers"
  grep -qi '^content-security-policy:.*frame-ancestors .*none' "$normal_headers"
}
trap cleanup EXIT
if [ "$(sudo -n sha256sum -- "$config" 2>/dev/null | awk '{print $1}' || true)" = "$config_digest" ]; then
  echo "Nginx config already current"
  verify_headers
  exit 0
fi
if sudo -n test -f "$config"; then
  sudo -n cp -p -- "$config" "$backup"
  had_config=1
fi
if ! sudo -n install -m 644 -- "$stage/nginx-production.conf" "$config"; then rollback; exit 1; fi
if ! sudo -n nginx -t; then rollback; exit 1; fi
if ! sudo -n systemctl reload nginx; then rollback; exit 1; fi
if ! sudo -n systemctl is-active --quiet nginx; then rollback; exit 1; fi
if ! verify_headers; then echo "Published Nginx framing policy did not pass verification" >&2; rollback; exit 1; fi`;
}

function deploy() {
  const config = fs.readFileSync(localConfig);
  validateConfig(config);
  if (!/^\/[A-Za-z0-9_.\/-]+$/.test(remoteConfig) || remoteConfig.includes('..')) throw new Error('Invalid remote Nginx config path');
  const target = connection();
  const stage = `/tmp/shuguang-nginx-${crypto.randomUUID()}`;
  try {
    ssh(`umask 077 && mkdir -m 700 -- ${shellQuote(stage)}`);
    remoteCommand('scp', ['-P', target.port, localConfig, `${target.target}:${stage}/nginx-production.conf`]);
    const digest = crypto.createHash('sha256').update(config).digest('hex');
    return ssh(buildRemoteCommand(stage, remoteConfig, digest));
  } catch (error) {
    try { ssh(`rm -rf -- ${shellQuote(stage)}`); } catch {}
    throw error;
  }
}

module.exports = { buildRemoteCommand, validateConfig, deploy };

if (require.main === module) {
  try {
    process.stdout.write(deploy());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
