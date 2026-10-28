const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CONTENT_SECURITY_POLICY, EMBEDDED_CONTENT_SECURITY_POLICY, isEmbeddedViewPath } = require('../backend/security-policy');
const { buildRemoteCommand, validateConfig } = require('../scripts/deploy-nginx-config.cjs');

test('embedded label viewer has a narrow framing exception', () => {
  const nginx = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx-production.conf'), 'utf8');
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.match(EMBEDDED_CONTENT_SECURITY_POLICY, /frame-ancestors 'self' app:/);
  assert.equal(isEmbeddedViewPath('/embed/pages/label-print/index'), true);
  assert.equal(isEmbeddedViewPath('/pages/label-print/index'), false);
  assert.equal(isEmbeddedViewPath('/embedding'), false);
  assert.doesNotThrow(() => validateConfig(nginx));
  assert.throws(() => validateConfig(nginx.replace("frame-ancestors 'self' app:", "frame-ancestors 'none'")), /Embedded browser policy/);
  assert.throws(() => validateConfig(nginx.replace('location ^~ /embed/ {', 'location ^~ /embedded/ {')), /location is missing/);
  const remote = buildRemoteCommand('/tmp/shuguang-nginx-test', '/etc/nginx/sites-available/shuguang', 'a'.repeat(64));
  assert.match(remote, /sha256sum/);
  assert.match(remote, /nginx -t/);
  assert.match(remote, /rollback/);
  assert.match(remote, /frame-ancestors .*app:/);
  assert.match(remote, /for route in \/embed\/ \/embed\/pages\/label-print\/index/);
  assert.match(remote, /grep -qi .*"\$headers" \|\| return 1/);
  assert.match(remote, /if grep -qiE '\^x-frame-options:/);
});
