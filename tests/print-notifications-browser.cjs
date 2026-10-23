const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('@playwright/test');

const root = path.resolve(process.env.PRINT_NOTICE_WEB_DIR || 'dist');
const qa = path.resolve(process.env.PRINT_NOTICE_QA_DIR || path.join('release', 'print-notifications'));
const token = 'c'.repeat(64);

function fingerprintPair(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
}

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename)) return response.writeHead(404).end();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  response.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(response);
});

async function seed(page, status = 'processing') {
  const now = Date.now();
  const fingerprint = fingerprintPair(token);
  await page.addInitScript(({ token, fingerprint, status, now }) => {
    if (localStorage.getItem('__sg_test_seeded')) return;
    localStorage.setItem('__sg_test_seeded', '1');
    localStorage.setItem('warehouse_remote_print_pair_v1', JSON.stringify({ data: token }));
    localStorage.setItem('warehouse_session_v1', JSON.stringify({ data: { token: 'session-token', user: { id: '1', username: 'mobile', role: 'viewer' } } }));
    localStorage.setItem('warehouse_print_notices_v1', JSON.stringify({ data: {
      version: 1,
      pairFingerprint: fingerprint,
      deviceId: 'device-mobile',
      records: [{
        id: 'remote-task-mobile',
        noteId: 18,
        noteNumber: 'SH-20261023-018',
        printer: 'LQ-630K',
        deviceId: 'device-mobile',
        createdAt: now,
        job: { id: 'remote-task-mobile', status, message: status === 'queued' ? '已送入LQ-630K打印队列，请以实际出纸为准' : status === 'uncertain' ? '打印机未返回明确结果' : '打印电脑正在处理原任务', created_at: now, updated_at: now }
      }]
    } }));
  }, { token, fingerprint, status, now });
}

async function main() {
  fs.mkdirSync(qa, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  let jobStatus = 'processing';
  let resolveCalls = 0;
  let submissions = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      let data = null;
      if (url.pathname === '/api/auth/guest') data = { token: 'session-token', user: { id: '1', username: 'mobile', role: 'viewer' } };
      else if (url.pathname === '/api/sync') data = { revision: 1 };
      else if (url.pathname === '/api/stats') data = { todayIn: 0, todayOut: 0, totalProducts: 0, totalStock: 0, lowStock: 0, totalValue: 0 };
      else if (url.pathname === '/api/remote-print/device') data = { id: 'device-mobile', name: '店里电脑', printer: 'LQ-630K', online: true, ready: true };
      else if (url.pathname === '/api/remote-print/history') data = [];
      else if (url.pathname === '/api/remote-print/jobs/remote-task-mobile/resolve') {
        resolveCalls++;
        data = { id: 'remote-task-mobile', status: 'queued', message: '已人工确认实际出纸', updated_at: Date.now() };
      } else if (url.pathname === '/api/remote-print/jobs/remote-task-mobile') {
        data = { id: 'remote-task-mobile', status: jobStatus, message: jobStatus === 'queued' ? '已送入LQ-630K打印队列，请以实际出纸为准' : jobStatus === 'uncertain' ? '打印机未返回明确结果' : '打印中', created_at: 1_800_000_000_000, updated_at: 1_800_000_000_000 };
      } else if (url.pathname === '/api/remote-print/jobs') {
        submissions++;
        data = { id: 'should-not-submit', status: 'waiting', message: 'unexpected' };
      } else if (url.pathname === '/api/print-notes') data = { items: [], total: 0, page: 1, page_size: 30 };
      else if (/^\/api\/(?:boards|products|customers|suppliers|transactions|ledger|production|orders)$/.test(url.pathname)) data = [];
      else data = {};
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    });
    await seed(page);

    await page.goto(origin + '/#/pages/print-center/index');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(qa, 'queued-start.png') });
    const banner = page.locator('[data-print-notice="remote-task-mobile"]:visible').first();
    await banner.waitFor();
    assert.match(await banner.innerText(), /打印处理中/);
    assert.match(await banner.innerText(), /SH-20261023-018/);
    assert.equal(await page.locator('[data-global="true"]').count(), 0, 'the in-page banner replaces the floating one');

    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(80);
      const box = await banner.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + .5, 'banner fits at ' + width + ': ' + JSON.stringify(box));
      const clipped = await banner.evaluate(element => {
        const nodes = [element, ...element.querySelectorAll('*')];
        return nodes.filter(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && (rect.left < -.5 || rect.right > innerWidth + .5);
        }).map(node => node.className || node.tagName);
      });
      assert.deepEqual(clipped, [], 'no horizontal clipping at ' + width);
      const textFits = await banner.evaluate(element => Array.from(element.querySelectorAll('strong, small, span'))
        .every(node => node.scrollWidth <= node.clientWidth + 1));
      assert.equal(textFits, true, 'text fits at ' + width);
    }
    await page.screenshot({ path: path.join(qa, 'queued-390.png') });

    await page.getByRole('button', { name: '刷新通知状态' }).click();
    await page.waitForTimeout(900);
    assert.equal(submissions, 0, 'refreshing status must never create a print job');
    assert.equal(resolveCalls, 0);

    jobStatus = 'uncertain';
    await page.getByRole('button', { name: '刷新通知状态' }).click();
    await page.waitForTimeout(600);
    await page.waitForFunction(() => document.querySelector('[data-print-notice="remote-task-mobile"]')?.getAttribute('data-tone') === 'danger');
    const uncertain = page.locator('[data-print-notice="remote-task-mobile"]');
    assert.match(await uncertain.innerText(), /打印结果待人工核对/);
    assert.match(await uncertain.innerText(), /不要再次发送/);
    await page.screenshot({ path: path.join(qa, 'uncertain-390.png') });
    await uncertain.getByRole('button', { name: '已出纸' }).click();
    await page.waitForFunction(() => document.querySelector('[data-print-notice="remote-task-mobile"]')?.getAttribute('data-tone') === 'success');
    assert.equal(resolveCalls, 1);
    assert.equal(submissions, 0, 'manual reconciliation must not submit a new job');
    assert.match(await page.locator('[data-print-notice="remote-task-mobile"]').innerText(), /经人工确认实际出纸/);

    await page.locator('[data-print-notice="remote-task-mobile"]').getByRole('button', { name: '关闭打印通知' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-print-notice="remote-task-mobile"]'));
    jobStatus = 'uncertain';
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('warehouse_print_notices_v1'));
      raw.data.records[0].job.status = 'uncertain';
      raw.data.records[0].dismissed = false;
      localStorage.setItem('warehouse_print_notices_v1', JSON.stringify(raw));
    });
    await page.reload();
    await page.waitForTimeout(800);
    await page.locator('.sg-glass-tab[data-tab="0"]').click();
    await page.waitForURL(/home/);
    await page.waitForTimeout(700);
    // The app mounts its global banner on the next rendered page.
    await page.reload();
    await page.waitForTimeout(500);
    await page.waitForURL(/home/);
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await page.locator('[data-testid="workbench-actions"]').waitFor({ timeout: 8000 });
    } catch (error) {
      console.log('HOME DIAGNOSTIC url=' + page.url());
      console.log('HOME DIAGNOSTIC errors=' + JSON.stringify(errors));
      console.log('HOME DIAGNOSTIC body=' + JSON.stringify((await page.locator('body').innerText()).slice(0, 2000)));
      console.log('HOME DIAGNOSTIC html=' + JSON.stringify((await page.content()).slice(0, 1000)));
      throw error;
    }
    await page.waitForTimeout(300);
    const floating = page.locator('[data-global="true"]:visible');
    await floating.waitFor();
    const floatingBox = await floating.boundingBox();
    assert.ok(floatingBox.x >= 0 && floatingBox.x + floatingBox.width <= 390.5);
    assert.equal(await page.locator('[data-print-notice="remote-task-mobile"]').count(), 1, 'one floating banner is shown outside the print center');
    await page.screenshot({ path: path.join(qa, 'global-390.png') });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(180);
    assert.equal(await page.locator('[data-print-notice="remote-task-mobile"]').count(), 0, 'desktop must not show mobile print notices');
    assert.deepEqual(errors, []);
    console.log('PASS: mobile print notifications at 320/375/390/430, manual reconciliation, no resubmission, cross-page banner, desktop hidden.');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
