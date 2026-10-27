// Browser acceptance for print-only, manually entered paperboard labels.
// API endpoints are local fixtures; no physical printer or inventory API is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

const webRoot = path.resolve(process.env.LABEL_PRINT_WEB_ROOT || 'dist');
const output = path.resolve(process.env.MANUAL_LABEL_CHECK_DIR || 'release/manual-label-print-check/browser');
const apiOrigin = 'https://youxishen.online';
const token = 'b'.repeat(64);
const printerName = 'K3-I911020404';

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const filename = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(webRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    return response.writeHead(404).end();
  }
  response.setHeader('Content-Type', ({
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png',
  })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(response);
});

const todayLocal = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

async function main() {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  let context;
  const jobs = new Map();
  const profiles = new Map();
  const requests = [];
  const posts = [];
  const statusReads = new Map();
  const boardRequests = [];
  const productWrites = [];
  let deviceOnline = true;
  let deviceReady = true;
  let calibrationId = '';
  let calibrationProfileId = '';
  const manualPostBehaviors = ['stored-lost-response', 'missing-first-response'];
  const errors = [];

  try {
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => localStorage.setItem(
      'sg_getting_started_seen_v1', JSON.stringify({ data: true })
    ));
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
            'access-control-allow-headers': 'Content-Type,Authorization,X-Warehouse-Device,X-Print-Client',
          },
        });
      }
      const body = request.postDataJSON?.() || {};
      const item = {
        method: request.method(),
        path: url.pathname,
        body,
        clientHeader: request.headers()['x-print-client'],
      };
      requests.push(item);
      if (url.pathname === '/api/boards' || url.pathname.startsWith('/api/boards/')) boardRequests.push(item);
      if ((url.pathname === '/api/products' || url.pathname.startsWith('/api/products/')) &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(item.method)) productWrites.push(item);

      const json = (data, status = 200) => route.fulfill({
        status,
        headers: { 'access-control-allow-origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify({ success: status < 400, data, ...(status >= 400 ? { message: 'fixture error' } : {}) }),
      });

      if (url.pathname === '/api/remote-print/labels/device') {
        if (item.clientHeader !== token) return json(null, 401);
        return json({
          id: 'shop-device-manual-fixture',
          name: '店里电脑',
          printer: printerName,
          online: deviceOnline,
          ready: deviceReady,
          profiles: [...profiles.values()].map(value => ({ ...value })),
          maxCopies: 99,
        });
      }
      if (url.pathname === '/api/remote-print/labels/profiles') {
        if (item.clientHeader !== token) return json(null, 401);
        const previous = profiles.get(body.profile.profileId);
        const saved = { ...body.profile, calibrated: Boolean(previous?.calibrated) };
        profiles.set(saved.profileId, saved);
        return json(saved);
      }
      const confirmMatch = /^\/api\/remote-print\/labels\/profiles\/([^/]+)\/confirm$/.exec(url.pathname);
      if (confirmMatch) {
        const profileId = decodeURIComponent(confirmMatch[1]);
        const saved = profiles.get(profileId);
        if (item.clientHeader !== token || body.jobId !== calibrationId ||
          profileId !== calibrationProfileId || jobs.get(calibrationId)?.status !== 'queued' || !saved) {
          return json(null, 409);
        }
        const confirmed = { ...saved, calibrated: true };
        profiles.set(profileId, confirmed);
        return json(confirmed);
      }
      if (url.pathname === '/api/remote-print/labels/jobs' && item.method === 'POST') {
        if (item.clientHeader !== token) return json(null, 401);
        posts.push(body);
        if (body.kind === 'calibration') {
          const job = {
            id: body.id, kind: body.kind, profileId: body.profileId, copies: body.copies,
            status: 'queued', message: 'K3 已确认出纸（校准样张）',
            created_at: Date.now(), updated_at: Date.now(),
          };
          calibrationId = body.id;
          calibrationProfileId = body.profileId;
          jobs.set(body.id, job);
          return json(job);
        }
        if (body.kind !== 'paperboard-manual') return json(null, 400);
        const behavior = manualPostBehaviors.shift() || 'ok';
        const job = {
          id: body.id, kind: body.kind, profileId: body.profileId, copies: body.copies,
          status: behavior === 'stored-lost-response' ? 'waiting' : 'queued',
          message: behavior === 'stored-lost-response'
            ? '等待标签打印电脑接收'
            : 'K3 已确认出纸（手填纸板标签）',
          created_at: Date.now(), updated_at: Date.now(),
        };
        if (behavior !== 'missing-first-response') jobs.set(body.id, job);
        if (behavior === 'stored-lost-response' || behavior === 'missing-first-response') {
          return route.abort('failed');
        }
        return json(job);
      }
      const jobMatch = /^\/api\/remote-print\/labels\/jobs\/([^/]+)$/.exec(url.pathname);
      if (jobMatch && item.method === 'GET') {
        const id = decodeURIComponent(jobMatch[1]);
        const job = jobs.get(id);
        if (!job) return json(null, 404);
        if (job.status === 'waiting') {
          const reads = (statusReads.get(id) || 0) + 1;
          statusReads.set(id, reads);
          if (reads >= 2) {
            job.status = 'queued';
            job.message = 'K3 已确认出纸（手填纸板标签）';
            job.updated_at = Date.now();
          }
        }
        return json(job);
      }
      if (url.pathname === '/api/auth/guest') return json({ token: 'manual-fixture', user: { id: 1, username: 'fixture', role: 'viewer' } });
      if (url.pathname === '/api/sync') return json({ revision: 1 });
      if (url.pathname === '/api/health') return json({ status: 'ok', authentication: false });
      if (url.pathname === '/api/stats') return json({ todayIn: 0, todayOut: 0, totalProducts: 0, totalStock: 0, lowStock: 0, totalValue: 0 });
      if (url.pathname === '/api/boards' && item.method === 'GET') return json([]);
      if (url.pathname.startsWith('/api/boards/')) return json(null, 404);
      if (url.pathname === '/api/products' && item.method === 'GET') {
        return json({ items: [], total: 0, page: 1, page_size: 12 });
      }
      if (url.pathname.startsWith('/api/products/')) return json(null, 404);
      return json([]);
    });

    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    const field = label => page.getByLabel(label, { exact: true }).locator('input');
    const expectDisabled = locator => expect.poll(() => locator.getAttribute('disabled')).not.toBeNull();
    const expectEnabled = locator => expect.poll(() => locator.getAttribute('disabled')).toBeNull();
    const manualMode = page.getByText('手动填写', { exact: true });
    const inventoryMode = page.getByText('从库存选择', { exact: true });
    const printButton = page.getByText('复核最新资料并发送到 K3', { exact: true });
    const fillRequired = async (customer = '客户手填验收') => {
      await field('客户 *').fill(customer);
      await field('纸板长（cm）*').fill('120');
      await field('纸板宽（cm）*').fill('80');
      await field('材质 / 配纸 *').fill('五层 BC 瓦楞纸板');
    };

    await page.goto(`${origin}/#/pages/label-print/index?print_pair=${token}`);
    await expect(manualMode).toHaveClass(/tabActive/, 'manual entry is the default');
    await expect(page.getByText(`在线 · ${printerName}`, { exact: true })).toBeVisible();
    assert.ok(!page.url().includes(token), 'pair token is removed from the page URL');
    await page.waitForTimeout(400);
    assert.equal(boardRequests.length, 0, 'default manual entry does not query inventory batches');
    assert.equal(requests.filter(item =>
      ['/api/boards', '/api/products'].includes(item.path) && item.method === 'GET'
    ).length, 0, 'default manual entry does not read board or product inventory');
    await fillRequired();
    await field('印刷版名（选填）').fill('A款彩印版');
    await field('颜色（选填）').fill('红黑');
    await field('数量（张，选填）').fill('0');
    await field('日期（选填）').fill(todayLocal());
    await expect(page.getByText('未填写', { exact: true })).toHaveCount(0);

    const initialInventoryRequests = boardRequests.length;
    await page.waitForTimeout(400);
    assert.equal(boardRequests.length, initialInventoryRequests, 'manual entry does not read board inventory');
    assert.equal(productWrites.length, 0, 'manual entry does not write product inventory');

    // Browsing an empty stock list is optional and must not wipe the user's draft.
    await inventoryMode.click();
    await page.getByText('纸板批次标签', { exact: true }).click();
    await expect(page.getByText('当前共享仓库还没有纸板批次记录。', { exact: true })).toBeVisible();
    await manualMode.click();
    await expect(field('客户 *')).toHaveValue('客户手填验收');
    await expect(field('纸板长（cm）*')).toHaveValue('120');
    await expect(field('纸板宽（cm）*')).toHaveValue('80');
    await expect(field('材质 / 配纸 *')).toHaveValue('五层 BC 瓦楞纸板');
    await expect(field('印刷版名（选填）')).toHaveValue('A款彩印版');
    await expect(field('颜色（选填）')).toHaveValue('红黑');
    await expect(field('数量（张，选填）')).toHaveValue('0');
    await expect(field('日期（选填）')).toHaveValue(todayLocal());

    assert.ok(requests.some(item => item.path === '/api/remote-print/labels/device' && item.method === 'GET'), 'pairing verifies the remote device');

    const profilePostsBeforeInvalidSize = requests.filter(item =>
      item.path === '/api/remote-print/labels/profiles' && item.method === 'POST'
    ).length;
    await page.getByLabel('实测宽度（mm）').locator('input').fill('58');
    await page.getByText('保存纸张配置', { exact: true }).click();
    await expect(page.getByText('手填纸板标签固定使用 70 × 100 mm 纸张', { exact: true })).toBeVisible();
    assert.equal(requests.filter(item =>
      item.path === '/api/remote-print/labels/profiles' && item.method === 'POST'
    ).length, profilePostsBeforeInvalidSize, 'manual labels reject a non-70mm profile before saving it');
    await page.getByLabel('实测宽度（mm）').locator('input').fill('70');
    await page.getByText('保存纸张配置', { exact: true }).click();
    await expect(page.getByText('70 × 100 mm · 浓度 4 · 待校准', { exact: true })).toBeVisible();
    const profileSave = requests.filter(item => item.path === '/api/remote-print/labels/profiles').at(-1);
    assert.equal(profileSave.body.profile.widthMm, 70);
    assert.equal(profileSave.body.profile.heightMm, 100);
    assert.equal(profileSave.body.profile.density, 4);
    const manualProfileId = profileSave.body.profile.profileId;

    await expectDisabled(page.getByText('请先完成一次校准', { exact: true }));
    await page.getByText('打印单张校准样张', { exact: true }).click();
    await expect(page.getByText('已核对校准实物', { exact: true })).toBeVisible();
    const calibration = posts.find(item => item.kind === 'calibration');
    assert.ok(calibration);
    assert.equal(calibration.profileId, manualProfileId);
    assert.equal(calibration.copies, 1);
    assert.equal(calibration.data, undefined);
    await page.getByText('已核对校准实物', { exact: true }).click();
    await expect(page.getByText('已确认校准样张实物。以后普通标签由打印机串口回执确认出纸后自动完成。')).toBeVisible();
    assert.equal(profiles.get(manualProfileId).calibrated, true);

    const preview = page.locator('iframe[title="K3 标签预览"]');
    const previewFrame = page.frameLocator('iframe[title="K3 标签预览"]');
    await expect(preview).toBeVisible();
    await expect(previewFrame.locator('body')).toContainText('客户手填验收');
    await expect(previewFrame.locator('body')).toContainText('120 × 80');
    await expect(previewFrame.locator('body')).toContainText('五层 BC 瓦楞纸板');
    await expect(previewFrame.locator('body')).toContainText('A款彩印版 · 红黑');
    await expect(previewFrame.locator('body')).toContainText('数量：0 张');
    await expect(previewFrame.locator('body')).toContainText(todayLocal());
    await expect(previewFrame.locator('body')).toContainText('不关联库存批次');
    await expect(previewFrame.locator('[data-qr], img')).toHaveCount(0);
    await expect(page.getByText('单张预览 70 × 100 mm，未发现内容溢出。', { exact: true })).toBeVisible();

    // Clearing required input, invalid dimensions/date and invalid copies each block printing.
    await field('客户 *').fill('');
    await expect(page.getByText('请补全客户', { exact: true })).toBeVisible();
    await expectDisabled(printButton);
    await field('客户 *').fill('客户手填验收');
    await field('纸板长（cm）*').fill('0');
    await expect(page.getByText('纸板长度（cm）必须是有效的正数值', { exact: true })).toBeVisible();
    await expectDisabled(printButton);
    await field('纸板长（cm）*').fill('120');
    await field('材质 / 配纸 *').fill('');
    await expect(page.getByText('请补全材质 / 配纸', { exact: true })).toBeVisible();
    await expectDisabled(printButton);
    await field('材质 / 配纸 *').fill('五层 BC 瓦楞纸板');
    await field('数量（张，选填）').fill('1.5');
    await expect(page.getByText('数量（张）必须是有效的非负整数', { exact: true })).toBeVisible();
    await expectDisabled(printButton);
    await field('数量（张，选填）').fill('0');
    await field('日期（选填）').fill('2026-02-31');
    await expect(page.getByText('日期无效', { exact: true })).toBeVisible();
    await expectDisabled(printButton);
    await field('日期（选填）').fill(todayLocal());
    await field('打印份数').fill('0');
    await expect(page.getByText('请输入 1–99 的整数份数。', { exact: true })).toBeVisible();
    await expectDisabled(printButton);
    await field('打印份数').fill('2');
    await expectEnabled(printButton);

    // Online/readiness remains part of the print gate.
    deviceOnline = false;
    await page.getByText('刷新状态', { exact: true }).click();
    await expect(page.getByText('打印电脑离线', { exact: true })).toBeVisible();
    await expectDisabled(page.getByText('等待打印电脑与 K3 就绪', { exact: true }));
    deviceOnline = true;
    await page.getByText('刷新状态', { exact: true }).click();
    await expect(page.getByText(`在线 · ${printerName}`, { exact: true })).toBeVisible();
    await expectEnabled(printButton);

    // Long customer text is retained in the preview and blocked by real HTML geometry.
    const longCustomer = '长客户名称'.repeat(24);
    await field('客户 *').fill(longCustomer);
    await expect(page.getByText('无法确认标签边界或检测到内容溢出；请修改可选字段后再打印。', { exact: true })).toBeVisible();
    await expectDisabled(printButton);
    const longGeometry = await preview.evaluate(element => {
      const doc = element.contentDocument;
      const target = doc?.querySelector('[data-field="customer"]');
      const maxHeight = target && doc?.defaultView
        ? parseFloat(doc.defaultView.getComputedStyle(target).maxHeight)
        : NaN;
      return {
        present: Boolean(target),
        overflow: Boolean(target && Number.isFinite(maxHeight) && target.scrollHeight > maxHeight + 2),
      };
    });
    assert.deepEqual(longGeometry, { present: true, overflow: true }, 'long text triggers HTML fit overflow');

    await field('客户 *').fill('客户手填验收');
    await expect(page.getByText('单张预览 70 × 100 mm，未发现内容溢出。', { exact: true })).toBeVisible();
    await expectEnabled(printButton);

    const geometryAtWidths = [];
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByText('单张预览 70 × 100 mm，未发现内容溢出。', { exact: true })).toBeVisible();
      const geometry = await preview.evaluate(element => {
        const doc = element.contentDocument;
        const label = doc?.querySelector('.warehouse-label');
        const body = doc?.querySelector('.paperboard-label');
        const rect = label?.getBoundingClientRect();
        const dataFits = [...(doc?.querySelectorAll('[data-fit]') || [])].every(node => {
          const maxHeight = doc?.defaultView
            ? parseFloat(doc.defaultView.getComputedStyle(node).maxHeight)
            : NaN;
          const verticalOverflow = node.classList.contains('paperboard-value')
            ? Number.isFinite(maxHeight) && node.scrollHeight > maxHeight + 2
            : node.scrollHeight > node.clientHeight + 2;
          return node.scrollWidth <= node.clientWidth + 2 && !verticalOverflow;
        });
        return {
          width: rect?.width || 0,
          height: rect?.height || 0,
          ratio: rect ? rect.width / rect.height : 0,
          dataFits,
          bodyFits: Boolean(body && body.scrollWidth <= body.clientWidth + 2 && body.scrollHeight <= body.clientHeight + 2),
        };
      });
      assert.ok(Math.abs(geometry.ratio - 0.7) < 0.01, `${width}px preview remains 70×100`);
      assert.equal(geometry.dataFits, true, `${width}px all preview HTML fields fit`);
      assert.equal(geometry.bodyFits, true, `${width}px preview body has no overflow`);
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(documentWidth <= width + 1, `${width}px document has no horizontal overflow`);
      geometryAtWidths.push(width);
      await page.screenshot({ path: path.join(output, `manual-label-${width}.png`), fullPage: true });
    }

    const boardsBeforePrint = boardRequests.length;
    const inventoryReadsBeforePrint = requests.filter(item =>
      ['/api/boards', '/api/products'].includes(item.path) && item.method === 'GET'
    ).length;
    const productWritesBeforePrint = productWrites.length;
    const expectedData = {
      customerName: '客户手填验收',
      boardLength: 120,
      boardWidth: 80,
      material: '五层 BC 瓦楞纸板',
      printPlate: 'A款彩印版',
      printColor: '红黑',
      receivedQty: 0,
      receivedDate: todayLocal(),
    };
    const firstManualRequest = page.waitForRequest(request =>
      request.method() === 'POST' && request.url() === `${apiOrigin}/api/remote-print/labels/jobs` &&
      request.postDataJSON()?.kind === 'paperboard-manual'
    );
    await printButton.click();
    await firstManualRequest;
    const firstManualPost = posts.filter(item => item.kind === 'paperboard-manual')[0];
    assert.ok(firstManualPost);
    await expect(page.getByText(`任务编号：${firstManualPost.id}`, { exact: true })).toBeVisible();
    await expect.poll(() => statusReads.get(firstManualPost.id) || 0, { timeout: 20000 }).toBeGreaterThan(0);
    await expect(page.getByText('出纸已确认，任务完成。', { exact: true })).toBeVisible({ timeout: 20000 });
    assert.deepEqual(firstManualPost.data, expectedData, 'posted DTO matches the visible manual draft');
    assert.equal(firstManualPost.profileId, manualProfileId);
    assert.equal(firstManualPost.copies, 2);
    for (const fieldName of ['batchId', 'batchUrl', 'productId', 'productUrl']) {
      assert.equal(Object.hasOwn(firstManualPost.data, fieldName), false, `${fieldName} is absent from manual labels`);
    }
    assert.ok((statusReads.get(firstManualPost.id) || 0) >= 1,
      `lost submission response is recovered by polling; id=${firstManualPost.id}, reads=${JSON.stringify([...statusReads])}, jobRequests=${JSON.stringify(requests.filter(item => item.path.startsWith('/api/remote-print/labels/jobs')).map(item => [item.method, item.path]))}`);
    assert.equal(posts.filter(item => item.kind === 'paperboard-manual').length, 1,
      'a lost response is polled instead of triggering a duplicate POST');
    assert.equal(boardRequests.length, boardsBeforePrint, 'manual print does not read inventory batches');
    assert.equal(requests.filter(item =>
      ['/api/boards', '/api/products'].includes(item.path) && item.method === 'GET'
    ).length, inventoryReadsBeforePrint, 'manual print does not read board or product inventory');
    assert.equal(productWrites.length, productWritesBeforePrint, 'manual print does not write product inventory');
    assert.equal(boardRequests.some(item => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(item.method)), false,
      'manual print never writes boards');

    // If polling says the server never received a new job, resending reuses the
    // frozen ID and exact snapshot even if the editable draft changes meanwhile.
    await field('客户 *').fill('冻结快照验收客户');
    await expectEnabled(printButton);
    await printButton.click();
    await expect(page.getByText('服务器尚未收到该任务；未自动重发。确认后可沿用原任务编号重新查询/发送。')).toBeVisible();
    await expect(page.getByText('沿用原任务编号重新发送', { exact: true })).toBeVisible();
    const frozenFirstPost = posts.filter(item => item.kind === 'paperboard-manual').at(-1);
    assert.ok(frozenFirstPost);
    await field('客户 *').fill('用户随后修改草稿');
    const resumeButton = page.getByText('沿用原任务编号重新发送', { exact: true });
    await inventoryMode.click();
    await expect(page.getByText('原任务暂不能续发：请先切回原任务对应的填写方式和标签类型。', { exact: true })).toBeVisible();
    await expectDisabled(resumeButton);
    await manualMode.click();
    await expect(page.getByText('70 × 100 mm · 浓度 4 · 已校准', { exact: true })).toBeVisible();
    await expectEnabled(resumeButton);
    await resumeButton.click();
    await expect(page.getByText('出纸已确认，任务完成。', { exact: true })).toBeVisible({ timeout: 20000 });
    const manualPosts = posts.filter(item => item.kind === 'paperboard-manual');
    assert.equal(manualPosts.length, 3, 'one lost response, one missing task, and one explicit resume');
    assert.equal(manualPosts[1].id, frozenFirstPost.id);
    assert.deepEqual(manualPosts[2].data, frozenFirstPost.data, 'resume uses the original immutable label snapshot');
    assert.equal(manualPosts[2].copies, frozenFirstPost.copies);
    assert.equal(manualPosts[2].profileId, frozenFirstPost.profileId);
    assert.ok(manualPosts[2].data.customerName !== '用户随后修改草稿', 'resume ignores edits made after the lost attempt');

    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.equal(productWrites.length, 0, 'no product inventory writes occurred');
    assert.equal(boardRequests.some(item => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(item.method)), false,
      'no board inventory writes occurred');
    console.log(JSON.stringify({
      passed: true,
      checks: [
        'default manual entry without stock reads or writes',
        'empty inventory navigation preserves the manual draft',
        '70×100 density-4 profile, calibration, online and copy gates',
        'required, number, date and long-text geometry validation',
        'preview and submitted payload match with no batch identity or QR',
        'two-copy print, lost-response polling without duplicate POST',
        'missing-job recovery reuses frozen id, payload and profile',
        '320/390/1280px screenshots and HTML geometry',
      ],
      requests: requests.length,
      boardRequests: boardRequests.length,
      productWrites: productWrites.length,
      manualPosts: manualPosts.length,
      screenshots: geometryAtWidths.map(width => path.join(output, `manual-label-${width}.png`)),
      physicalPrintingTested: false,
    }, null, 2));
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
