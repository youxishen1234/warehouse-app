const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = file => fs.readFileSync(file, 'utf8');
const requiredDirectives = ["default-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "script-src 'self' 'nonce-sg-bootstrap'", "connect-src 'self'"];
const distRoot = process.env.TARO_OUTPUT_DIR || 'dist';

test('H5 and Electron publish the same constrained CSP policy', () => {
  const source = read('src/index.html');
  const dist = read(`${distRoot}/index.html`);
  const desktop = read('desktop/main.cjs');
  for (const directive of requiredDirectives) {
    assert.match(source, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(dist, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(desktop, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const artifact of [source, dist, desktop]) assert.match(artifact, /http:\/\/152\.136\.100\.200:\*/);
  assert.doesNotMatch(source, /script-src\s+[^;]*unsafe-inline/);
  assert.doesNotMatch(source, /connect-src\s+\*/);
  for (const html of [source, dist]) {
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)];
    assert.ok(inlineScripts.length >= 4, 'bootstrap scripts should remain present');
    assert(inlineScripts.every(match => /\bnonce=["']sg-bootstrap["']/.test(match[0])), 'every inline script must carry the CSP nonce');
  }
});
