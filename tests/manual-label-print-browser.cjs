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

const fnv1a = value => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
};
const profileSignature = profile => JSON.stringify({
  printerName: profile.printerName, widthMm: profile.widthMm, heightMm: profile.heightMm,
  density: profile.density, marginMm: profile.marginMm, paperStyle: 'gap',
});
const attemptFingerprint = (deviceId, printer, profile, kind, copies, data) => fnv1a(JSON.stringify({
  deviceId, printer, profileId: profile.profileId, profile: profileSignature(profile), kind, copies, data,
}));

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
  let connectionAvailable = false;
  let labelDeviceAvailable = false;
  let connectionGate;
  let releaseConnection = () => {};
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

      if (url.pathname === '/api/remote-print/connect' && item.method === 'POST') {
        if (connectionGate) await connectionGate;
        if (!connectionAvailable) return json(null, 503);
        return json({
          client: token,
          device: {
            id: 'shop-device-manual-fixture', name: '店里电脑', printer: 'EPSON LQ-630K ESC/P2',
            online: deviceOnline, ready: deviceReady,
          },
        });
      }
      if (url.pathname === '/api/remote-print/labels/device') {
        if (item.clientHeader !== token) return json(null, 401);
        if (!labelDeviceAvailable) return json(null, 409);
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
    const dimensionGroup = page.locator('fieldset[data-label-dimensions]');
    const expectDimensionRow = async () => {
      const boxes = await dimensionGroup.locator('input').evaluateAll(inputs => inputs.map(input => {
        const rect = input.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }));
      assert.equal(boxes.length, 3, 'length, width, and height are grouped together');
      assert.ok(boxes.every(box => box.width > 0 && box.height > 0), 'all three dimension inputs are visible');
      assert.ok(Math.max(...boxes.map(box => box.y)) - Math.min(...boxes.map(box => box.y)) <= 2,
        'length, width, and height remain on one row');
      assert.ok(boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x, 'dimension order is length, width, height');
    };
    const expectDisabled = locator => expect.poll(() => locator.getAttribute('disabled')).not.toBeNull();
    const expectEnabled = locator => expect.poll(() => locator.getAttribute('disabled')).toBeNull();
    const manualMode = page.getByText('手动填写', { exact: true });
    const inventoryMode = page.getByText('从库存选择', { exact: true });
    const printButton = page.getByText('复核最新资料并发送到 K3', { exact: true });
    const fillRequired = async (customer = '客户手填验收') => {
      await field('客户 *').fill(customer);
      await expect(field('客户 *')).toHaveValue(customer);
      await field('纸板长（cm）*').fill('120');
      await expect(field('纸板长（cm）*')).toHaveValue('120');
      await field('纸板宽（cm）*').fill('80');
      await field('纸板高（cm）*').fill('60');
      await field('材质 / 配纸 *').fill('五层 BC 瓦楞纸板');
    };
    const scrollPageTop = () => page.evaluate(() => {
      for (const element of document.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        if (element.scrollHeight > element.clientHeight && ['auto', 'scroll'].includes(style.overflowY)) {
          element.scrollTop = 0;
        }
      }
      window.scrollTo(0, 0);
    });
    const expectPreviewGeometry = async (iframe, context) => {
      const geometry = await iframe.evaluate(element => {
        const doc = element.contentDocument;
        const label = doc?.querySelector('.warehouse-label');
        const body = doc?.querySelector('.paperboard-label');
        const spec = doc?.querySelector('[data-field="spec"]');
        const iframeRect = element.getBoundingClientRect();
        const labelRect = label?.getBoundingClientRect();
        const range = doc?.createRange();
        if (range && spec) range.selectNodeContents(spec);
        const specLines = range ? [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).length : 0;
        const frameWidth = element.clientWidth;
        const frameHeight = element.clientHeight;
        return {
          iframeRatio: iframeRect.width / Math.max(1, iframeRect.height),
          labelRatio: labelRect ? labelRect.width / Math.max(1, labelRect.height) : 0,
          iframeRect: { x: iframeRect.x, y: iframeRect.y, width: iframeRect.width, height: iframeRect.height },
          iframeClient: { width: frameWidth, height: frameHeight },
          labelRect: labelRect ? { x: labelRect.x, y: labelRect.y, right: labelRect.right, bottom: labelRect.bottom, width: labelRect.width, height: labelRect.height } : null,
          labelTransform: label ? doc.defaultView.getComputedStyle(label).transform : null,
          documentSize: doc ? { scrollWidth: doc.documentElement.scrollWidth, scrollHeight: doc.documentElement.scrollHeight, clientWidth: doc.documentElement.clientWidth, clientHeight: doc.documentElement.clientHeight } : null,
          bodyRect: body ? (() => { const rect = body.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }; })() : null,
          labelFitsIframe: Boolean(labelRect &&
            labelRect.left >= -1 && labelRect.top >= -1 &&
            labelRect.right <= frameWidth + 2 && labelRect.bottom <= frameHeight + 2),
          iframeDocumentFits: Boolean(doc && doc.documentElement.scrollWidth <= frameWidth + 2 &&
            doc.documentElement.scrollHeight <= frameHeight + 2),
          bodyFits: Boolean(body && body.scrollWidth <= body.clientWidth + 2 &&
            body.scrollHeight <= body.clientHeight + 2),
          specLines,
        };
      });
      assert.ok(Math.abs(geometry.iframeRatio - 0.7) < 0.01, `${context} iframe itself remains 70×100`);
      assert.ok(Math.abs(geometry.labelRatio - 0.7) < 0.01, `${context} label content remains 70×100`);
      assert.equal(geometry.labelFitsIframe, true, `${context} entire label content is visible inside the iframe: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.iframeDocumentFits, true, `${context} iframe document has no clipped content`);
      assert.equal(geometry.bodyFits, true, `${context} label body has no overflow`);
      assert.equal(geometry.specLines, 1, `${context} paper specification remains on one line`);
      return geometry;
    };

    await page.goto(`${origin}/#/pages/management/index?section=labels`);
    await expect(manualMode).toHaveClass(/tabActive/, 'manual entry is the default before connection');
    await expect(page.getByText('fixture error', { exact: true })).toBeVisible();
    const retryConnection = page.getByText('重试连接', { exact: true });
    await expectEnabled(retryConnection);
    await expect(page.getByLabel('打印电脑配对码')).toHaveCount(0);
    await expect(page.getByText('扫描连接二维码', { exact: true })).toHaveCount(0);
    const connectsBeforeDraft = requests.filter(item => item.path === '/api/remote-print/connect').length;
    await fillRequired();
    await expect(field('纸板高（cm）*')).toHaveValue('60');
    const unpairedPreview = page.locator('iframe[title="K3 标签预览"]');
    const unpairedPreviewFrame = page.frameLocator('iframe[title="K3 标签预览"]');
    await expect(unpairedPreview).toBeVisible();
    await expect(unpairedPreviewFrame.locator('body')).toContainText('120 × 80 × 60');
    await expect(page.getByText('单张预览 70 × 100 mm，未发现内容溢出。', { exact: true })).toBeVisible();
    await expectDisabled(page.getByText('等待打印电脑与 K3 就绪', { exact: true }));
    assert.equal(posts.filter(item => item.kind === 'paperboard-manual').length, 0,
      'a valid preview before connection never submits a print job');
    await expectPreviewGeometry(unpairedPreview, 'preview while automatic connection is unavailable');
    const connectsAfterDraft = requests.filter(item => item.path === '/api/remote-print/connect').length;
    assert.ok(connectsAfterDraft >= 1 && connectsAfterDraft <= connectsBeforeDraft + 1,
      `draft and preview renders do not loop connection requests; returning window focus may retry once (${connectsBeforeDraft} → ${connectsAfterDraft})`);
    await scrollPageTop();

    // Network and app focus retry discovery; explicit retry preserves the draft.
    connectionGate = new Promise(resolve => { releaseConnection = resolve; });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => requests.filter(item => item.path === '/api/remote-print/connect').length).toBe(connectsAfterDraft + 1);
    await expect(page.getByText('正在连接打印电脑…', { exact: true })).toBeVisible();
    await expect(field('客户 *')).toBeEditable();
    await expect(field('纸板长（cm）*')).toBeEditable();
    await field('客户 *').fill('连接期间继续填写');
    await expect(field('客户 *')).toHaveValue('连接期间继续填写');
    await field('客户 *').fill('客户手填验收');
    await expect(field('客户 *')).toHaveValue('客户手填验收');
    await expectDisabled(page.getByText('等待打印电脑与 K3 就绪', { exact: true }));
    connectionGate = undefined;
    releaseConnection();
    await expectEnabled(retryConnection);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => requests.filter(item => item.path === '/api/remote-print/connect').length).toBe(connectsAfterDraft + 2);
    await expectEnabled(retryConnection);
    connectionAvailable = true;
    await retryConnection.click();
    await expectEnabled(retryConnection);
    assert.equal(requests.filter(item => item.path === '/api/remote-print/connect').length, connectsAfterDraft + 3);
    assert.equal(await page.evaluate(() => localStorage.getItem('warehouse_remote_print_pair_v1')), null,
      'a default computer is not saved before its K3 label capability is verified');
    await expect(field('客户 *')).toHaveValue('客户手填验收');
    labelDeviceAvailable = true;
    await retryConnection.click();
    await expect(page.getByText(`在线 · ${printerName}`, { exact: true })).toBeVisible();
    const connectsAfterSuccess = requests.filter(item => item.path === '/api/remote-print/connect').length;
    assert.equal(connectsAfterSuccess, connectsAfterDraft + 4,
      'manual retry discovers the default computer without entering a code');
    await expect(field('客户 *')).toHaveValue('客户手填验收');
    await expect(field('纸板长（cm）*')).toHaveValue('120');
    await expect(field('纸板宽（cm）*')).toHaveValue('80');
    await expect(field('纸板高（cm）*')).toHaveValue('60');
    await expect(field('材质 / 配纸 *')).toHaveValue('五层 BC 瓦楞纸板');
    assert.equal(posts.length, 0, 'connection and retries never submit calibration or label jobs');
    assert.ok(!page.url().includes(token), 'automatic connection never puts the internal client in the page URL');

    // A fresh visit starts with empty fields while reusing its verified client.
    await page.reload();
    await expect(manualMode).toHaveClass(/tabActive/, 'manual entry is the default');
    await expect(page.getByText(`在线 · ${printerName}`, { exact: true })).toBeVisible();
    assert.equal(requests.filter(item => item.path === '/api/remote-print/connect').length, connectsAfterSuccess,
      'a saved connection does not rediscover or change the default computer on reload');
    await expect(field('客户 *')).toHaveValue('');
    await expect(field('纸板长（cm）*')).toHaveValue('');
    await expect(field('纸板宽（cm）*')).toHaveValue('');
    await expect(field('纸板高（cm）*')).toHaveValue('');
    await expect(field('材质 / 配纸 *')).toHaveValue('');
    await page.waitForTimeout(400);
    assert.equal(boardRequests.length, 0, 'default manual entry does not query inventory batches');
    assert.equal(requests.filter(item =>
      ['/api/boards', '/api/products'].includes(item.path) && item.method === 'GET'
    ).length, 0, 'default manual entry does not read board or product inventory');
    await fillRequired();
    await expect(field('纸板高（cm）*')).toHaveValue('60');
    await expectDimensionRow();
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
    await expect(field('纸板高（cm）*')).toHaveValue('60');
    await expect(field('材质 / 配纸 *')).toHaveValue('五层 BC 瓦楞纸板');
    await expect(field('印刷版名（选填）')).toHaveValue('A款彩印版');
    await expect(field('颜色（选填）')).toHaveValue('红黑');
    await expect(field('数量（张，选填）')).toHaveValue('0');
    await expect(field('日期（选填）')).toHaveValue(todayLocal());

    assert.ok(requests.some(item => item.path === '/api/remote-print/labels/device' && item.method === 'GET'), 'automatic connection verifies remote label capability');

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
    await expect(previewFrame.locator('body')).toContainText('120 × 80 × 60');
    await expect(previewFrame.locator('body')).toContainText('五层 BC 瓦楞纸板');
    await expect(previewFrame.locator('body')).toContainText('A款彩印版 · 红黑');
    await expect(previewFrame.locator('body')).toContainText('数量：0 张');
    await expect(previewFrame.locator('body')).toContainText(todayLocal());
    await expect(previewFrame.locator('body')).toContainText('不关联库存批次');
    await expect(previewFrame.locator('[data-qr], img')).toHaveCount(0);
    await expect(page.getByText('单张预览 70 × 100 mm，未发现内容溢出。', { exact: true })).toBeVisible();
    await expect(page.locator('iframe[title="K3 标签预览"]')).toHaveCount(1, 'actual preview is shown only once');
    await expect(page.getByText('标签类型', { exact: true })).toHaveCount(0, 'manual fields are not repeated as a separate summary');
    const previewLayout = await page.evaluate(() => {
      const stage = document.querySelector('section[aria-label="实际标签预览"]');
      const dimensions = document.querySelector('fieldset[data-label-dimensions]');
      const calibration = [...document.querySelectorAll('*')].find(node =>
        node.children.length === 0 && node.textContent.trim() === '1 · 纸张配置与一次性校准');
      const iframe = stage?.querySelector('iframe[title="K3 标签预览"]');
      const follows = (first, second) => Boolean(first && second &&
        (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING));
      return {
        stageCount: document.querySelectorAll('section[aria-label="实际标签预览"]').length,
        iframeInStage: Boolean(iframe),
        previewBeforeDimensions: follows(stage, dimensions),
        previewBeforeCalibration: follows(stage, calibration),
      };
    });
    assert.deepEqual(previewLayout, {
      stageCount: 1, iframeInStage: true, previewBeforeDimensions: true, previewBeforeCalibration: true,
    }, 'actual label preview is presented before editing and calibration');
    await expectPreviewGeometry(preview, 'paired preview');
    await scrollPageTop();
    await preview.screenshot({ path: path.join(output, 'manual-label-preview.png') });

    // Clearing required input, invalid dimensions/date and invalid copies each block printing.
    await field('客户 *').fill('');
    await expect(page.getByText('请补全客户', { exact: true })).toBeVisible();
    await expectDisabled(printButton);
    await field('客户 *').fill('客户手填验收');
    await field('纸板长（cm）*').fill('0');
    await expect(page.getByText('纸板长度（cm）必须是有效的正数值', { exact: true })).toBeVisible();
    await expectDisabled(printButton);
    await field('纸板长（cm）*').fill('120');
    const manualPostsBeforeMissingHeight = posts.filter(item => item.kind === 'paperboard-manual').length;
    await field('纸板高（cm）*').fill('');
    await expectDisabled(printButton);
    assert.equal(posts.filter(item => item.kind === 'paperboard-manual').length, manualPostsBeforeMissingHeight,
      'a missing height cannot submit a manual label');
    await field('纸板高（cm）*').fill('0');
    await expect(page.getByText('纸板高度（cm）必须是有效的正数值', { exact: true })).toBeVisible();
    await expectDisabled(printButton);
    await field('纸板高（cm）*').fill('60');
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
    await scrollPageTop();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await scrollPageTop();
      await expectDimensionRow();
      await expect(page.getByText('单张预览 70 × 100 mm，未发现内容溢出。', { exact: true })).toBeVisible();
      if (width === 390) {
        await dimensionGroup.screenshot({ path: path.join(output, 'manual-label-dimensions-390.png') });
      }
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
      await expect(async () => {
        await expectPreviewGeometry(preview, `${width}px preview`);
      }).toPass({ timeout: 5000 });
      await scrollPageTop();
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
      boardHeight: 60,
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
    await expect(async () => {
      await expect(previewFrame.locator('body')).toContainText('冻结快照验收客户');
      await expect(previewFrame.locator('body')).not.toContainText('客户手填验收');
      await preview.evaluate(async element => {
        const document = element.contentDocument;
        if (!document) throw new Error('current label preview document is not ready');
        await document.fonts.ready;
      });
      await expectPreviewGeometry(preview, 'changed-customer preview');
    }).toPass({ timeout: 10000 });
    await expect(page.getByText('单张预览 70 × 100 mm，未发现内容溢出。', { exact: true })).toBeVisible();
    await expectEnabled(printButton);
    const missingManualRequest = page.waitForRequest(request =>
      request.method() === 'POST' && request.url() === `${apiOrigin}/api/remote-print/labels/jobs` &&
      request.postDataJSON()?.kind === 'paperboard-manual'
    );
    await printButton.click();
    await missingManualRequest;
    const missingManualPost = posts.filter(item => item.kind === 'paperboard-manual')[1];
    assert.ok(missingManualPost, 'missing-job scenario submits a second manual task');
    assert.deepEqual(missingManualPost.data, { ...expectedData, customerName: '冻结快照验收客户' },
      'second submission contains exactly the reviewed draft shown in the current preview');
    await expect(page.getByText('服务器尚未收到该任务；未自动重发。确认后可沿用原任务编号重新查询/发送。')).toBeVisible();
    await expect(page.getByText('沿用原任务编号重新发送', { exact: true })).toBeVisible();
    const frozenFirstPost = posts.filter(item => item.kind === 'paperboard-manual').at(-1);
    assert.ok(frozenFirstPost);
    assert.equal(frozenFirstPost.data.boardHeight, 60, 'frozen attempt retains the entered height');
    await field('客户 *').fill('用户随后修改草稿');
    await field('纸板高（cm）*').fill('75');
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
    assert.equal(manualPosts[2].data.boardHeight, 60, 'resume uses the frozen height instead of the edited draft height');

    // Legacy attempts remain viewable but cannot be resent without the newly required height.
    const legacyData = {
      customerName: '旧任务客户', boardLength: 120, boardWidth: 80,
      material: '五层 BC 瓦楞纸板', printPlate: '旧印刷版', printColor: '黑色',
    };
    const legacyAttempt = {
      id: 'legacy-manual-attempt-no-height',
      fingerprint: attemptFingerprint(
        'shop-device-manual-fixture', printerName, profiles.get(manualProfileId), 'paperboard-manual', 1,
        legacyData
      ),
      deviceId: 'shop-device-manual-fixture', printer: printerName, profileId: manualProfileId,
      kind: 'paperboard-manual', copies: 1,
      data: legacyData,
      startedAt: Date.now(),
    };
    await page.evaluate(attempt => localStorage.setItem(
      'warehouse_remote_label_attempt_v1', JSON.stringify({ data: attempt })
    ), legacyAttempt);
    const manualPostsBeforeLegacyRecovery = posts.filter(item => item.kind === 'paperboard-manual').length;
    await page.reload();
    await expect(page.getByText(`任务编号：${legacyAttempt.id}`, { exact: true })).toBeVisible();
    await expect(field('客户 *')).toHaveValue('旧任务客户');
    await expect(field('纸板长（cm）*')).toHaveValue('120');
    await expect(field('纸板宽（cm）*')).toHaveValue('80');
    await expect(field('纸板高（cm）*')).toHaveValue('');
    await expect(page.getByText('原任务暂不能续发：原任务缺少有效的长宽高，请重新填写并核对预览。', { exact: true })).toBeVisible();
    await expectDisabled(page.getByText('沿用原任务编号重新发送', { exact: true }));
    assert.equal(posts.filter(item => item.kind === 'paperboard-manual').length, manualPostsBeforeLegacyRecovery,
      'legacy attempt without height is never silently resent');

    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.equal(productWrites.length, 0, 'no product inventory writes occurred');
    assert.equal(boardRequests.some(item => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(item.method)), false,
      'no board inventory writes occurred');
    assert.ok(requests.every(item => item.path !== '/api/remote-print/jobs'), 'manual labels never enter the delivery-note queue');
    assert.ok(requests.filter(item => !['GET', 'OPTIONS'].includes(item.method) && item.path !== '/api/auth/guest')
      .every(item => item.path === '/api/remote-print/connect' || item.path.startsWith('/api/remote-print/labels/')),
    'writes are restricted to automatic connection and the isolated label queue');
    console.log(JSON.stringify({
      passed: true,
      checks: [
        'default manual entry without stock reads or writes',
        'automatic no-code connection, stable failure, online/focus and manual retry without interrupting draft input',
        'empty inventory navigation preserves the manual draft',
        '70×100 density-4 profile, calibration, online and copy gates',
        'required long/width/height, number, date and long-text geometry validation',
        'three dimensions share one row on responsive viewports; actual preview leads the form',
        'legacy no-height attempts remain readable but cannot be resent',
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
    releaseConnection();
    if (context) await context.close();
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
