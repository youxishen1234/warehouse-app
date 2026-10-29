const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('release contains only the current web interface and no retired page assets', () => {
  const output = process.env.TARO_OUTPUT_DIR || 'dist';
  for (const name of ['print.html', 'management.html', 'customers.html', 'legacy-entry.js', 'js/home-search.js', 'css/polish.css']) {
    assert.equal(fs.existsSync(path.join(output, name)), false, name);
  }
  assert(fs.existsSync(path.join(output, 'css/web-shell.css')));
  const config = fs.readFileSync('src/app.config.ts', 'utf8');
  assert.doesNotMatch(config, /pages\/(?:ledger|board-stock|index)\/index/);
  const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /home-search\.js|polish\.css|legacy-entry/);
});

test('source tree contains no retired prototype or mock data entry', () => {
  for (const retired of [
    'src/preview-pages',
    'src/components/DemoFrame',
    'src/services/cloud.ts',
    'scripts/demo-server.cjs',
    'prototypes/h5',
    'prototypes/ios-glass'
  ]) {
    const directory = path.join(__dirname, '..', retired);
    const files = fs.existsSync(directory) && fs.statSync(directory).isDirectory()
      ? fs.readdirSync(directory, { recursive: true }).filter(name => fs.statSync(path.join(directory, name)).isFile())
      : [];
    assert.equal(files.length, 0, retired);
  }
});

test('retired web routes are blocked before backend static files can serve an old interface', () => {
  const server = fs.readFileSync('backend/server.js', 'utf8');
  assert(server.indexOf("res.status(410)") < server.indexOf('app.use(express.static(WEB_ROOT))'));
  const nginx = fs.readFileSync('deploy/nginx-production.conf', 'utf8');
  assert.match(nginx, /return 410/);
  assert(nginx.includes('web-(?:releases|current)'));
  assert(server.includes('web-(?:releases|current)'));
  assert.match(nginx, /location ~ \^\/\(\?:js\|css\|static\|assets\)\/ \{ try_files \$uri =404; \}/);
});

test('every AI navigation action opens a configured current page', () => {
  const tools = require('../backend/ai-tools');
  const config = fs.readFileSync('src/app.config.ts', 'utf8');
  for (const page of tools.get('open_page').schema.properties.page.enum) {
    const plan = tools.prepare({}, { action: 'open_page', parameters: { page } });
    assert.equal(plan.status, 'navigate');
    const route = plan.navigation.url.split('?')[0].slice(1);
    assert(config.includes("'" + route + "'"), plan.navigation.url);
  }
  assert.equal(tools.prepare({}, { action: 'open_page', parameters: { page: 'finance' } }).navigation.url, '/pages/business-center/index?section=finance');
});
