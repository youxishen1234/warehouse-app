// Production H5 verification against isolated API fixtures. Never uses live business data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, expect } = require('@playwright/test');

const configuredBuild = process.env.DAILY_BACKUP_WEB_DIR || process.env.TARO_OUTPUT_DIR;
if (!configuredBuild) throw new Error('DAILY_BACKUP_WEB_DIR or TARO_OUTPUT_DIR must name an isolated build');
const dist = path.resolve(configuredBuild);
const releaseSegments = path.relative(path.parse(dist).root, dist).split(path.sep);
assert(releaseSegments.includes('release') && !['www', 'dist'].includes(path.basename(dist)), 'Do not use or modify the shared www/dist directories');
const output = path.resolve(process.env.DAILY_BACKUP_BROWSER_OUTPUT || path.join(path.dirname(dist), 'built-browser'));
const statusFixture = { enabled: true, active: true, timeZone: 'Asia/Shanghai', hour: 2, keepDays: 30, lastSuccessAt: '2026-10-19T18:00:00.000Z', lastAttemptAt: '2026-10-19T18:00:00.000Z', lastError: null, nextScheduledAt: '2026-10-20T18:00:00.000Z', nextRetryAt: null, running: false, location: 'server', verified: true };
const exportFixture = { exportedAt: statusFixture.lastSuccessAt, data: { products: [{ id: 13, name: '隔离纸板' }], ledger_attachment_files: { evidence: 'isolated-photo-fixture' } } };
const sessionFixture = { token: 'daily-backup-isolated-build-token', user: { id: 'daily-build-fixture', username: 'daily-build-fixture', role: 'operator' } };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device', 'access-control-expose-headers': 'X-Warehouse-Revision' };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
});

async function main() {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const width of [320, 390, 736]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'America/Los_Angeles', acceptDownloads: true });
      await context.addInitScript(({ sessionFixture }) => {
        localStorage.setItem('warehouse_session_v1', JSON.stringify({ data: sessionFixture }));
        localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
      }, { sessionFixture });
      const errors = [], failedAssets = [], external = [], writes = [], calls = [];
      let dailyMode = 'healthy';
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname.startsWith('/api/')) {
          if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
          calls.push({ path: url.pathname, method: request.method() });
          if (!['GET', 'HEAD'].includes(request.method()) && url.pathname !== '/api/auth/guest') {
            writes.push(url.pathname);
            return route.fulfill({ status: 409, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Isolated verification never writes business data' }) });
          }
          if (url.pathname === '/api/backup/daily/status' && dailyMode === 'undeployed') return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试：服务器尚未部署每日备份' }) });
          if (url.pathname === '/api/backup/daily/latest' && dailyMode === 'download-failure') return route.fulfill({ status: 503, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试：读取备份失败' }) });
          const data = url.pathname === '/api/auth/guest' ? sessionFixture
            : url.pathname === '/api/auth/me' ? sessionFixture.user
            : url.pathname === '/api/backup/daily/status' ? statusFixture
            : ['/api/backup', '/api/backup/daily/latest'].includes(url.pathname) ? exportFixture
            : url.pathname === '/api/health' ? { status: 'ok' }
            : url.pathname === '/api/sync' ? { revision: 1 }
            : [];
          return route.fulfill({ status: 200, headers: { ...cors, 'X-Warehouse-Revision': '1' }, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
        }
        if (url.origin === base || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
        external.push(url.origin + url.pathname);
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.status() >= 400 && ['.js', '.css'].includes(path.extname(new URL(response.url()).pathname))) failedAssets.push(response.url()); });
      await page.goto(base + '/#/pages/backup/index');
      await expect(page.getByText('每日备份正常', { exact: true })).toBeVisible();
      await expect(page.getByText('北京时间 02:00', { exact: true })).toBeVisible();
      await expect(page.getByText('最近 30 份 · 存在服务器', { exact: true })).toBeVisible();
      await expect(page.getByText('2026-10-20 02:00:00（北京时间）', { exact: true }).first()).toBeVisible();
      const fontSize = locator => locator.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      const typography = {
        heading: await fontSize(page.getByText('每日服务器备份', { exact: true })),
        body: await fontSize(page.getByText('最近成功', { exact: true })),
        buttons: await Promise.all(['刷新状态', '下载最近备份'].map(label => fontSize(page.getByText(label, { exact: true }))))
      };
      assert(typography.heading >= 18 && typography.heading <= 24, `actual heading must stay readable: ${JSON.stringify(typography)}`);
      assert(typography.body >= 14 && typography.body <= 18, `actual body must stay readable: ${JSON.stringify(typography)}`);
      const actionDom = await page.getByText('刷新状态', { exact: true }).evaluate(el => el.parentElement.outerHTML);
      assert(typography.buttons.length === 2 && typography.buttons.every(size => size >= 14 && size <= 18), `actual action text must stay readable: ${JSON.stringify(typography)} ${actionDom}`);
      await expect(page.getByText('刷新状态', { exact: true })).toBeEnabled();
      await expect(page.getByText('下载最近备份', { exact: true })).toBeEnabled();
      const refreshColor = await page.getByText('刷新状态', { exact: true }).evaluate(el => getComputedStyle(el).color);
      assert.equal(refreshColor, 'rgb(34, 85, 201)', 'enabled refresh retains contrast despite Taro boolean attribute styles');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `healthy build no overflow ${width}`);
      await page.screenshot({ path: path.join(output, `backup-built-${width}.png`), fullPage: true });
      const latestPromise = page.waitForEvent('download');
      await page.getByText('下载最近备份', { exact: true }).click();
      const latest = await latestPromise;
      const latestFile = path.join(output, `latest-${width}.json`); await latest.saveAs(latestFile);
      assert.deepEqual(JSON.parse(fs.readFileSync(latestFile, 'utf8')), exportFixture);
      await expect(page.getByText(/已发起下载/)).toBeVisible();
      dailyMode = 'download-failure'; await page.getByText('下载最近备份', { exact: true }).click();
      await expect(page.getByText('下载失败：测试：读取备份失败', { exact: true })).toBeVisible();
      const liveError = await page.getByText('下载失败：测试：读取备份失败', { exact: true }).evaluate(el => Boolean(el.closest('[aria-live=polite]')));
      assert.equal(liveError, true, 'download failure retains aria-live in actual Taro output');
      dailyMode = 'undeployed'; await page.getByText('刷新状态', { exact: true }).click();
      await expect(page.getByText('未连接 · 备份状态未确认', { exact: true })).toBeVisible();
      await expect(page.getByText('导出备份 JSON', { exact: true })).toBeVisible();
      await expect(page.getByText('选择 JSON 恢复', { exact: true })).toBeVisible();
      const manualPromise = page.waitForEvent('download'); await page.getByText('导出备份 JSON', { exact: true }).click();
      const manual = await manualPromise; const manualFile = path.join(output, `manual-${width}.json`); await manual.saveAs(manualFile);
      assert.deepEqual(JSON.parse(fs.readFileSync(manualFile, 'utf8')), exportFixture, 'daily service failure does not block existing manual export');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `undeployed build no overflow ${width}`);
      await page.screenshot({ path: path.join(output, `backup-undeployed-${width}.png`), fullPage: true });
      assert.deepEqual(errors, []); assert.deepEqual(failedAssets, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
      results.push({ width, ok: true, calls, typography, actualBuild: true, downloadContentVerified: true, undeployedDailyAllowsManualBackup: true, noOverflow: true });
      await context.close();
    }
    const report = { ok: true, dist, output, results };
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
