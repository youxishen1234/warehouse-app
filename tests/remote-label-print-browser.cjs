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
const board = { id:'BOARD-20261025-ABCDEF123456', boardLength:120, boardWidth:80, fluteType:'B', supplier:'纸板厂', customerName:'客户甲', material:'牛卡高瓦', printPlate:'包装A', printColor:'红黑', receivedQty:800, remainingQty:0, date:'2026-10-25' };
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
  const profiles = new Map();
  const requests = [];
  let deviceOnline = true;
  let deviceReady = true;
  let lostLabelResponse = false;
  let rejectNextBoardJob = false;
  let labelStatusReads = 0;
  let postCount = 0;
  let calibrationId = '';
  let calibrationProfileId = '';
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
        profiles: [...profiles.values()].map(item => ({ ...item })),
        maxCopies: 99
      });
    }
    if (url.pathname === '/api/remote-print/labels/profiles') {
      if (request.headers()['x-print-client'] !== token) return json(null, 401);
      const previous = profiles.get(body.profile.profileId);
      const saved = { ...body.profile, calibrated: Boolean(previous?.calibrated) };
      profiles.set(saved.profileId, saved);
      return json(saved);
    }
    const confirmMatch = /^\/api\/remote-print\/labels\/profiles\/([^/]+)\/confirm$/.exec(url.pathname);
    if (confirmMatch) {
      const profileId = decodeURIComponent(confirmMatch[1]);
      const saved = profiles.get(profileId);
      if (request.headers()['x-print-client'] !== token || body.jobId !== calibrationId ||
        profileId !== calibrationProfileId || jobs.get(calibrationId)?.status !== 'queued' || !saved) return json(null, 409);
      const confirmed = { ...saved, calibrated: true };
      profiles.set(profileId, confirmed);
      return json(confirmed);
    }
    if (url.pathname === '/api/remote-print/labels/jobs' && request.method() === 'POST') {
      if (request.headers()['x-print-client'] !== token) return json(null, 401);
      postCount += 1;
      if (body.kind === 'paperboard-batch' && rejectNextBoardJob) {
        rejectNextBoardJob = false;
        board.printColor = '银黑';
        return json(null, 409);
      }
      const job = { id: body.id, kind: body.kind, profileId: body.profileId, copies: body.copies, status: 'queued', message: 'K3 已确认出纸（页 2 → 3）', created_at: Date.now(), updated_at: Date.now() };
      if (body.kind === 'calibration') {
        calibrationId = body.id;
        calibrationProfileId = body.profileId;
      }
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
    if (url.pathname === '/api/boards') return json([board]);
    if (url.pathname === '/api/boards/' + board.id) {
      if (request.method() === 'GET') return json({ ...board });
      if (request.method() === 'OPTIONS') return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS','access-control-allow-headers':'Content-Type,Authorization,X-Warehouse-Device'}});
      return route.continue();
    }
    return json([]);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    // Keep this regression on the prior finished-product inventory flow now
    // that the label page opens in manual paperboard mode by default.
    await page.goto(`${origin}/#/pages/label-print/index?kind=finished-product&id=12&print_pair=${token}`);
    await expect(page.getByText('电脑 USB 打印 K3', { exact: true })).toBeVisible();
    await expect(page.getByText('在线 · K3-I911020404', { exact: true })).toBeVisible();
    await expect(page.getByLabel('打印电脑配对码')).toHaveCount(0);
    assert.ok(!page.url().includes(token), 'pair token is removed from the page URL after validation');
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
    const finishedProfileId = saved.body.profile.profileId;

    await page.locator('taro-button-core').filter({ hasText: /^打印单张校准样张$/ }).click();
    await expect(page.locator('taro-button-core').filter({ hasText: /^已核对校准实物$/ })).toBeVisible();
    const calibration = requests.find(item => item.path === '/api/remote-print/labels/jobs');
    assert.equal(calibration.body.kind, 'calibration');
    assert.equal(calibration.body.copies, 1);
    assert.equal(calibration.body.data, undefined);
    assert.equal(calibration.body.profileId, finishedProfileId);
    await page.locator('taro-button-core').filter({ hasText: /^已核对校准实物$/ }).click();
    await expect(page.getByText('已确认校准样张实物。以后普通标签由打印机串口回执确认出纸后自动完成。')).toBeVisible();
    assert.equal(profiles.get(finishedProfileId).density, 3);
    assert.equal(profiles.get(finishedProfileId).calibrated, true, 'the finished-product density-3 profile is independently calibrated');

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

    await page.goto(origin + '/#/pages/label-print/index?kind=paperboard-batch&id=' + board.id);
    const sendBoard = page.locator('taro-button-core').filter({ hasText: /^(复核最新资料并发送到 K3|请先完成一次校准)$/ });
    const densityThreeBoardProfile = page.locator('taro-button-core').filter({ hasText: /^70 × 100 mm · 浓度 3 · 已校准$/ });
    await expect(page.getByText(/浓度：4（电脑直接设置）/)).toBeVisible();
    await expect(densityThreeBoardProfile).toHaveCount(0, 'paperboard mode hides the finished-product density-3 profile');
    await expect(sendBoard).toHaveText('请先完成一次校准');
    assert.notEqual(await sendBoard.getAttribute('disabled'), null, 'formal paperboard printing remains disabled before a density-4 profile is saved and calibrated');

    await page.locator('taro-button-core').filter({ hasText: /^保存纸张配置$/ }).click();
    const boardProfileButton = page.locator('taro-button-core').filter({ hasText: /^70 × 100 mm · 浓度 4 · 待校准$/ });
    await expect(boardProfileButton).toBeVisible();
    const boardProfileSave = requests.filter(item => item.path === '/api/remote-print/labels/profiles' && item.method === 'POST').at(-1);
    assert.equal(boardProfileSave.body.profile.widthMm, 70);
    assert.equal(boardProfileSave.body.profile.heightMm, 100);
    assert.equal(boardProfileSave.body.profile.density, 4);
    assert.notEqual(boardProfileSave.body.profile.profileId, finishedProfileId, 'density 4 uses a distinct profile id');
    assert.equal(profiles.get(boardProfileSave.body.profile.profileId).calibrated, false, 'new paperboard profile starts uncalibrated');
    assert.equal(profiles.get(finishedProfileId).calibrated, true, 'saving the paperboard profile preserves density-3 calibration');

    await page.locator('taro-button-core').filter({ hasText: /^打印单张校准样张$/ }).click();
    await expect(page.locator('taro-button-core').filter({ hasText: /^已核对校准实物$/ })).toBeVisible();
    const boardCalibration = requests.filter(item =>
      item.path === '/api/remote-print/labels/jobs' && item.method === 'POST' && item.body.kind === 'calibration').at(-1).body;
    assert.equal(boardCalibration.profileId, boardProfileSave.body.profile.profileId);
    assert.equal(profiles.get(boardCalibration.profileId).calibrated, false, 'density-4 profile remains uncalibrated while its sample awaits physical confirmation');
    assert.equal(profiles.get(finishedProfileId).calibrated, true);
    await page.locator('taro-button-core').filter({ hasText: /^已核对校准实物$/ }).click();
    await expect(page.getByText('已确认校准样张实物。以后普通标签由打印机串口回执确认出纸后自动完成。')).toBeVisible();
    const boardCalibratedProfileButton = page.locator('taro-button-core').filter({ hasText: /^70 × 100 mm · 浓度 4 · 已校准$/ });
    await expect(boardCalibratedProfileButton).toBeVisible();
    assert.equal(profiles.get(boardCalibration.profileId).calibrated, true);
    assert.equal(profiles.get(finishedProfileId).density, 3);
    assert.equal(profiles.get(finishedProfileId).calibrated, true, 'calibrating density 4 does not alter density-3 profile');

    const previewFrame = page.frameLocator('iframe[title="K3 标签预览"]');
    for (const value of ['客户甲', '牛卡高瓦', '包装A', '红黑']) {
      await expect(previewFrame.locator('body')).toContainText(value);
    }
    const previewReady = page.getByText('单张预览 70 × 100 mm，未发现内容溢出。', { exact: true });
    await expect(previewReady).toBeVisible();
    // Taro's custom button is not always interpreted as a native button by Playwright.
    // Wait for the component's actual disabled attribute to be absent before clicking.
    await expect.poll(() => sendBoard.getAttribute('disabled')).toBeNull();

    board.printColor = '蓝黑';
    const beforeBoardPosts = requests.filter(item =>
      item.path === '/api/remote-print/labels/jobs' && item.method === 'POST').length;
    await sendBoard.click();
    await expect(page.getByText(/资料已更新（颜色）/)).toBeVisible();
    assert.equal(requests.filter(item =>
      item.path === '/api/remote-print/labels/jobs' && item.method === 'POST').length, beforeBoardPosts,
    'stale color is not sent');
    await expect(previewFrame.locator('body')).toContainText('蓝黑');
    await expect(previewReady).toBeVisible();
    await expect.poll(() => sendBoard.getAttribute('disabled')).toBeNull();

    // Model a server-side batch edit between the UI's fresh read and job submission.
    rejectNextBoardJob = true;
    await sendBoard.click();
    await expect(page.getByText(/服务器发现资料已更新（颜色）/)).toBeVisible();
    await expect(previewFrame.locator('body')).toContainText('银黑');
    const boardPostsAfterConflict = requests.filter(request =>
      request.method === 'POST' && request.path === '/api/remote-print/labels/jobs' &&
      request.body.kind === 'paperboard-batch');
    assert.equal(boardPostsAfterConflict.length, 1, 'a 409 conflict does not trigger an automatic second POST');
    assert.equal(boardPostsAfterConflict[0].body.data.printColor, '蓝黑', 'conflict request contains the previewed version');
    await expect(previewReady).toBeVisible();
    await expect.poll(() => sendBoard.getAttribute('disabled')).toBeNull();
    await sendBoard.click();
    await expect.poll(() => requests.filter(request =>
      request.method === 'POST' && request.path === '/api/remote-print/labels/jobs' &&
      request.body.kind === 'paperboard-batch').length).toBe(2);
    const boardJob = requests.filter(request =>
      request.method === 'POST' && request.body.kind === 'paperboard-batch').at(-1).body;
    assert.equal(boardJob.data.customerName, board.customerName);
    assert.equal(boardJob.data.material, board.material);
    assert.equal(boardJob.data.printPlate, board.printPlate);
    assert.equal(boardJob.data.printColor, '银黑');
    assert.equal(boardJob.data.receivedQty, 800);
    assert.equal(boardJob.data.receivedDate, '2026-10-25');
    assert.equal(board.remainingQty, 0, 'label printing does not consume inventory');
    for (const width of [320,390,1280]) {
      await page.setViewportSize({width,height:900});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:path.join(output,'board-label-'+width+'.png'),fullPage:true});
    }
    await page.locator('taro-button-core').filter({ hasText: /^成品标签$/ }).click();
    const finishedProfileButton = page.locator('taro-button-core').filter({ hasText: /^70 × 100 mm · 浓度 3 · 已校准$/ });
    await expect(finishedProfileButton).toBeVisible();
    await expect(finishedProfileButton).toHaveClass(/profileSelected/, 'switching back to finished products selects the already calibrated density-3 profile');
    await expect(page.locator('taro-button-core').filter({ hasText: /^70 × 100 mm · 浓度 4 ·/ })).toHaveCount(0,
      'finished-product mode hides the paperboard density-4 profile');
    await expect(page.getByText(/请先完成一次校准|完成一次校准并核对实物后/)).toHaveCount(0,
      'finished-product printing does not require recalibration after switching from paperboard');
    deviceOnline = false;
    await page.locator('taro-button-core').filter({ hasText: /^刷新状态$/ }).click();
    await expect(page.getByText('打印电脑离线', { exact: true })).toBeVisible();
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.ok(requests.every(item => item.path !== '/api/remote-print/jobs'), 'label path never enters the delivery-note 630K queue');
    assert.ok(requests.filter(item => !['GET', 'OPTIONS'].includes(item.method) && item.path !== '/api/auth/guest')
      .every(item => item.path.startsWith('/api/remote-print/labels/')), 'all writes stay on the isolated label queue');
    console.log(JSON.stringify({
      passed: true,
      checks: ['pairing and HTTP-header token handling', 'separate density-3 finished-product and density-4 paperboard profiles with independent calibration', 'real label preview and fresh-record validation', 'lost-response durable recovery without duplicate job', 'manual confirmation is not a printer receipt', 'business board fields, stale-color/409 rejection, and no stock mutation', 'offline state', '320/390/1280px layout'],
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
