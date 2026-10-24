// Browser acceptance for the phone -> internet -> shop PC -> USB K3 path.
// All API endpoints are local in-memory fixtures; no physical printer is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

const webRoot = path.resolve(process.env.LABEL_PRINT_WEB_ROOT || 'dist');
const output = path.resolve(process.env.REMOTE_LABEL_CHECK_DIR || 'release/remote-label-print-check/browser');
const apiOrigin = 'https://youxishen.online';
const token = 'a'.repeat(64);
const product = {
  id: 12, name: 'K3 成品标签测试', category: '纸箱', specification: '70 × 100 mm',
  unit: '个', price: 1, stock: 8, safety_stock: 1, created_at: 1, updated_at: 1,
  material: '牛皮纸', corrugation: 'B', layers: 3, weight: 120
};
const profile = {
  profileId: 'remote-test-profile', printerName: 'K3-I911020404', widthMm: 70, heightMm: 100,
  paperStyle: 'gap', density: 3, marginMm: { top: 0.6, right: 0.5, bottom: 0.5, left: 0.5 }, calibrated: false
};

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const filename = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(webRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    return response.writeHead(404).end();
  }
  response.setHeader('Content-Type', ({
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png'
  })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(response);
});

async function main() {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const jobs = new Map();
  const requests = [];
  let deviceOnline = true;
  let deviceReady = true;
  let lostLabelResponse = false;
  let labelStatusReads = 0;
  let postCount = 0;
  let confirmedProfile = false;
  let calibrationId = '';
  const errors = [];
  await context.addInitScript(() => {
    localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== apiOrigin || !url.pathname.startsWith('/api/')) return route.abort();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'access-control-allow-headers': 'Content-Type,Authorization,X-Warehouse-Device,X-Print-Client'
        }
      });
    }
    const body = request.postDataJSON?.() || {};
    requests.push({ method: request.method(), path: url.pathname, body, clientHeader: request.headers()['x-print-client'] });
    const json = (data, status = 200) => route.fulfill({
      status, headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/json', body: JSON.stringify({ success: status < 400, data, ...(status >= 400 ? { message: 'fixture error' } : {}) })
    });
    if (url.pathname === '/api/remote-print/labels/device') {
      if (request.headers()['x-print-client'] !== token) return json(null, 401);
      return json({
        id: 'shop-device-fixture', name: '店里电脑', printer: profile.printerName,
        online: deviceOnline, ready: deviceReady,
        profiles: jobs.get('profile') ? [{ ...jobs.get('profile'), calibrated: confirmedProfile }] : [],
        maxCopies: 99
      });
    }
    if (url.pathname === '/api/remote-print/labels/profiles') {
      if (request.headers()['x-print-client'] !== token) return json(null, 401);
      jobs.set('profile', { ...body.profile, calibrated: confirmedProfile });
      return json(jobs.get('profile'));
    }
    if (/^\/api\/remote-print\/labels\/profiles\/[^/]+\/confirm$/.test(url.pathname)) {
      if (request.headers()['x-print-client'] !== token || body.jobId !== calibrationId || jobs.get(calibrationId)?.status !== 'queued') return json(null, 409);
      confirmedProfile = true;
      jobs.set('profile', { ...jobs.get('profile'), calibrated: true });
      return json(jobs.get('profile'));
    }
    if (url.pathname === '/api/remote-print/labels/jobs' && request.method() === 'POST') {
      if (request.headers()['x-print-client'] !== token) return json(null, 401);
      postCount += 1;
      const job = { id: body.id, kind: body.kind, profileId: body.profileId, copies: body.copies, status: 'queued', message: 'K3 已确认出纸（页 2 → 3）', created_at: Date.now(), updated_at: Date.now() };
      if (body.kind === 'calibration') calibrationId = body.id;
      jobs.set(body.id, job);
      if (body.kind !== 'calibration' && !lostLabelResponse) {
        lostLabelResponse = true;
        job.status = 'waiting';
        job.message = '等待标签打印电脑接收';
        return route.abort('failed');
      }
      return json(job);
    }
    const jobMatch = /^\/api\/remote-print\/labels\/jobs\/([^/]+)$/.exec(url.pathname);
    if (jobMatch && request.method() === 'GET') {
      const id = decodeURIComponent(jobMatch[1]);
      const job = jobs.get(id);
      if (!job) return json(null, 404);
      if (job.kind !== 'calibration' && job.status === 'waiting') {
        labelStatusReads += 1;
        if (labelStatusReads >= 3) {
          job.status = 'queued';
          job.message = 'K3 已确认出纸（页 2 → 3）';
          job.updated_at = Date.now();
        }
      }
      return json(job);
    }
    if (/^\/api\/remote-print\/labels\/jobs\/[^/]+\/resolve$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      const job = jobs.get(id);
      if (!job || job.status !== 'uncertain') return json(null, 409);
      job.status = body.outcome === 'printed' ? 'queued' : 'failed';
      job.message = body.outcome === 'printed' ? '经人工核对，出纸正常' : '经人工核对未出纸，请重新发送打印';
      return json(job);
    }
    if (url.pathname === '/api/auth/guest') return json({ token: 'fixture', user: { id: 1, username: 'fixture', role: 'viewer' } });
    if (url.pathname === '/api/sync') return json({ revision: 1 });
    if (url.pathname === '/api/health') return json({ status: 'ok', authentication: false });
    if (url.pathname === '/api/stats') return json({ todayIn: 0, todayOut: 0, totalProducts: 1, totalStock: 8, lowStock: 0, totalValue: 8 });
    if (url.pathname === '/api/products') {
      return json(url.searchParams.has('page') ? { items: [product], total: 1, page: 1, page_size: 12 } : [product]);
    }
    if (url.pathname === '/api/products/12') return json(product);
    if (url.pathname === '/api/boards') return json([]);
    return json([]);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${origin}/#/pages/label-print/index`);
    await expect(page.getByText('电脑 USB 打印 K3', { exact: true })).toBeVisible();
    assert.equal(new URL(page.url()).search, '', 'pair token is not placed in the page URL');
    await page.getByLabel('打印电脑配对码').locator('input').fill(token);
    await page.locator('taro-button-core').filter({ hasText: /^验证并连接打印电脑$/ }).click();
    await expect(page.getByText('在线 · K3-I911020404', { exact: true })).toBeVisible();
    assert.ok(requests.some(item => item.path === '/api/remote-print/labels/device' && item.method === 'GET'), 'pairing verifies the remote device');
    assert.ok(requests.filter(item => item.path.includes('/remote-print/labels/')).every(item => item.clientHeader === token), 'pair code is sent only in the X-Print-Client request header');
    assert.ok(requests.every(item => !decodeURIComponent(item.path).includes(token)), 'pair code never appears in a request URL');
    assert.ok(requests.filter(item => item.path.includes('/labels/')).every(item => item.body?.token === undefined), 'pair token is never copied into JSON bodies');

    await page.locator('taro-button-core').filter({ hasText: /^保存纸张配置$/ }).click();
    await expect(page.locator('taro-button-core').filter({ hasText: /待校准/ })).toBeVisible();
    const saved = requests.find(item => item.path === '/api/remote-print/labels/profiles');
    assert.equal(saved.body.profile.widthMm, 70);
    assert.equal(saved.body.profile.heightMm, 100);
    assert.equal(saved.body.profile.density, 3);
    assert.deepEqual(saved.body.profile.marginMm, { top: 0.6, right: 0.5, bottom: 0.5, left: 0.5 });

    await page.locator('taro-button-core').filter({ hasText: /^打印单张校准样张$/ }).click();
    await expect(page.locator('taro-button-core').filter({ hasText: /^已核对校准实物$/ })).toBeVisible();
    const calibration = requests.find(item => item.path === '/api/remote-print/labels/jobs');
    assert.equal(calibration.body.kind, 'calibration');
    assert.equal(calibration.body.copies, 1);
    assert.equal(calibration.body.data, undefined);
    await page.locator('taro-button-core').filter({ hasText: /^已核对校准实物$/ }).click();
    await expect(page.getByText('已确认校准样张实物。以后普通标签由打印机串口回执确认出纸后自动完成。')).toBeVisible();

    await expect(page.locator('taro-button-core').filter({ hasText: /K3 成品标签测试/ })).toBeVisible();
    await page.locator('taro-button-core').filter({ hasText: /K3 成品标签测试/ }).click();
    await expect(page.locator('iframe[title="K3 标签预览"]')).toBeVisible();
    await expect(page.getByText(/单张预览 70 × 100 mm/)).toBeVisible();
    await expect(page.locator('taro-button-core').filter({ hasText: /^复核最新资料并发送到 K3$/ })).not.toHaveAttribute('disabled');
    const labelRequest = page.waitForRequest(request =>
      request.method() === 'POST' &&
      request.url() === `${apiOrigin}/api/remote-print/labels/jobs` &&
      request.postDataJSON()?.kind === 'finished-product'
    );
    await page.locator('taro-button-core').filter({ hasText: /^复核最新资料并发送到 K3$/ }).click();
    await expect(page.getByText(/任务编号：label-/)).toBeVisible();
    await labelRequest;
    await expect.poll(() => requests.filter(item =>
      item.path === '/api/remote-print/labels/jobs' && item.method === 'POST' && item.body.kind === 'finished-product'
    ).length).toBe(1);
    const labelPost = requests.filter(item => item.path === '/api/remote-print/labels/jobs' && item.method === 'POST' && item.body.kind === 'finished-product');
    assert.equal(labelPost.length, 1, 'the label job is submitted once even when the response is lost');
    assert.equal(labelPost[0].body.copies, 1);
    assert.equal(labelPost[0].body.data.name, product.name);

    await page.reload();
    await expect(page.getByText('在线 · K3-I911020404', { exact: true })).toBeVisible();
    await expect(page.getByText('出纸已确认，任务完成。', { exact: true })).toBeVisible();
    const postsAfterReload = requests.filter(item => item.path === '/api/remote-print/labels/jobs' && item.method === 'POST').length;
    assert.equal(postsAfterReload, 2, 'reload resumes polling the durable job id without duplicate submission');

    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const dimensions = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        root: document.querySelector('[class*=remote-module__page]')?.scrollWidth
      }));
      assert.ok(dimensions.document <= width + 1, `${width}px layout has no document overflow`);
      assert.ok(!dimensions.root || dimensions.root <= width + 1, `${width}px remote label root has no overflow`);
      await page.screenshot({ path: path.join(output, `remote-label-${width}.png`), fullPage: true });
    }

    const completedJob = jobs.get(labelPost[0].body.id);
    completedJob.status = 'uncertain';
    completedJob.message = '打印结果未确认，请检查实物';
    await page.reload();
    await expect(page.getByText('打印结果未确认，请检查实物', { exact: true })).toBeVisible();
    await page.locator('taro-button-core').filter({ hasText: /^已经出纸$/ }).click();
    await expect(page.getByText('经人工核对，出纸正常', { exact: true })).toBeVisible();
    await expect(page.getByText('出纸已确认，任务完成。', { exact: true })).toBeVisible();
    await expect(page.getByText('打印机已确认出纸，任务完成。', { exact: true })).toHaveCount(0);
    assert.equal(requests.filter(item => item.path === '/api/remote-print/labels/jobs' && item.method === 'POST').length, 2,
      'manual paper confirmation records a result without resubmitting the label');

    deviceOnline = false;
    await page.locator('taro-button-core').filter({ hasText: /^刷新状态$/ }).click();
    await expect(page.getByText('打印电脑离线', { exact: true })).toBeVisible();
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.ok(requests.every(item => item.path !== '/api/remote-print/jobs'), 'label path never enters the delivery-note 630K queue');
    assert.ok(requests.filter(item => !['GET', 'OPTIONS'].includes(item.method) && item.path !== '/api/auth/guest')
      .every(item => item.path.startsWith('/api/remote-print/labels/')), 'all writes stay on the isolated label queue');
    console.log(JSON.stringify({
      passed: true,
      checks: ['pairing and HTTP-header token handling', 'USB profile save with default 70×100 mm', 'single-copy calibration and physical confirmation', 'real label preview and fresh-record validation', 'lost-response durable recovery without duplicate job', 'manual confirmation is not a printer receipt', 'offline state', '320/390/1280px layout'],
      requests: requests.length,
      postedLabelJobs: requests.filter(item => item.path === '/api/remote-print/labels/jobs' && item.body.kind !== 'calibration').length,
      screenshots: [320, 390, 1280].map(width => path.join(output, `remote-label-${width}.png`)),
      physicalPrintingTested: false
    }, null, 2));
  } finally {
    await context.close();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
