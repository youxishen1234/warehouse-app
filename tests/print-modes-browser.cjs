const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');

// Complete H5 assets only; no build, deployment or source-preview replacement.
// PRINT_WEB_ORIGIN permits online static assets, but ALL API origins remain
// fulfilled in memory. Business writes are rejected, never sent to the server.
const webRoot = path.resolve(process.env.PRINT_WEB_DIR || 'release/layout-label-check-web');
const engine = process.env.PRINT_BROWSER || 'chromium';
const artifacts = path.resolve(process.env.PRINT_ARTIFACTS || 'release/print-modes-check', engine);
const guest = { token: 'print-modes-isolated-fixture', user: { id: 'print-modes-reader', username: 'print-modes-reader', role: 'viewer' } };
const note = {
  id: 901, number: 'TEST-PRINT-MODES-901', version: 1, company: '本机回归测试公司',
  customer_id: null, customer_name: '模式回归客户（仅本机）', address: '隔离测试地址',
  phone: '13800000000', receiver: '测试收货人', sender: '测试送货人', date: '2026-10-21', paper: '241-93',
  items: [{ product_id: null, name: '本机测试纸箱', specification: '30×20×15', unit: '个', quantity: 10, price: 2, amount: 20, remark: '' }],
  total: 20, created_at: 1792540800000, updated_at: 1792540800000,
};
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,X-Warehouse-Device' };
const requests = [], unexpected = [], errors = [], checks = [], layoutEvidence = [];
const server = http.createServer((request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch (_) { return response.writeHead(400).end(); }
  const filename = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (request.method !== 'GET' || !filename.startsWith(webRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return response.writeHead(404).end();
  response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(response);
});

async function installFixture(context, webOrigin, native = false) {
  await context.addInitScript(initial => {
    localStorage.setItem('warehouse_session_v1', JSON.stringify({ data: initial.guest }));
    localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
    if (!initial.native) return;
    const methods = ['getState', 'getActiveJob', 'getRecentJobs', 'removeListener'];
    window.__printModesNativeCalls = [];
    window.CapacitorCustomPlatform = { name: 'ios' };
    window.Capacitor = {
      PluginHeaders: [{ name: 'OfficialLabelPrinter', methods: [...methods.map(name => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }] }],
      nativePromise(plugin, method) {
        window.__printModesNativeCalls.push({ plugin, method });
        if (plugin !== 'OfficialLabelPrinter') return Promise.reject(new Error('Unexpected native plugin: ' + plugin));
        if (method === 'getState') return Promise.resolve({ supported: true, connected: false, mediaProfiles: [], productionEnabled: false, maxCopies: 1, hardwareBusy: false, reason: '测试原生状态：K3 真机尚未完成验收，正式打印保持关闭。' });
        if (method === 'getActiveJob') return Promise.resolve({ job: null });
        if (method === 'getRecentJobs') return Promise.resolve({ jobs: [] });
        if (method === 'removeListener') return Promise.resolve();
        return Promise.reject(new Error('Unexpected native call: ' + method));
      },
      nativeCallback(plugin, method) {
        window.__printModesNativeCalls.push({ plugin, method });
        return Promise.resolve('print-modes-fixture-listener');
      },
    };
  }, { guest, native });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      requests.push({ method, path: url.pathname, origin: url.origin });
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const fulfill = (data, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: status === 200, data, ...(status !== 200 ? { message: '隔离测试未允许此接口或写入' } : {}) }) });
      if (url.pathname === '/api/auth/guest' && ['GET', 'POST'].includes(method)) return fulfill(guest);
      if (method !== 'GET') { unexpected.push({ method, path: url.pathname, reason: 'business write blocked' }); return fulfill(null, 405); }
      if (url.pathname === '/api/health') return fulfill({ online: true, dataReadable: true, dataWritable: true });
      if (url.pathname === '/api/sync') return fulfill({ revision: 'print-modes-isolated-1' });
      if (url.pathname === '/api/stats') return fulfill({ todayIn: 0, todayOut: 0, totalProducts: 0, totalStock: 0, lowStock: 0, totalValue: 0 });
      if (url.pathname === '/api/print-notes') return fulfill({ items: [note], total: 1, page: 1, page_size: 30 });
      if (url.pathname === '/api/print-notes/' + note.id) return fulfill(note);
      if (url.pathname === '/api/products') return fulfill({ items: [], total: 0, page: 1, page_size: 12 });
      if (['/api/boards', '/api/customers', '/api/suppliers', '/api/transactions'].includes(url.pathname)) return fulfill([]);
      unexpected.push({ method, path: url.pathname, reason: 'unknown API blocked' });
      return fulfill(null, 404);
    }
    if (/^https?:$/.test(url.protocol) && url.origin === webOrigin && ['GET', 'HEAD'].includes(method)) return route.continue();
    unexpected.push({ method, path: url.pathname, origin: url.origin, reason: 'non-static external request blocked' });
    return route.abort();
  });
}

async function main() {
  if (!process.env.PRINT_WEB_ORIGIN) assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), 'PRINT_WEB_DIR must contain a complete H5 build');
  fs.mkdirSync(artifacts, { recursive: true });
  if (!process.env.PRINT_WEB_ORIGIN) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const webOrigin = process.env.PRINT_WEB_ORIGIN ? new URL(process.env.PRINT_WEB_ORIGIN).origin : 'http://127.0.0.1:' + server.address().port;
  let browser, page, failure;
  try {
    assert.ok(['chromium', 'webkit'].includes(engine), 'PRINT_BROWSER must be chromium or webkit');
    browser = await (engine === 'webkit' ? webkit : chromium).launch(engine === 'webkit' || !process.env.PRINT_BROWSER_EXECUTABLE ? {} : { executablePath: process.env.PRINT_BROWSER_EXECUTABLE });
    const options = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'zh-CN', serviceWorkers: 'block', hasTouch: true };
    const context = await browser.newContext(options);
    await installFixture(context, webOrigin);
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    const active = () => page.locator('.taro_page:visible').last();
    const modes = () => active().getByRole('navigation', { name: '打印类型', exact: true });
    const button = name => active().getByRole('button', { name, exact: true });
    const field = (index, name) => active().getByLabel('第' + index + '项' + name, { exact: true });
    const expectModes = async selected => {
      await expect(modes()).toBeVisible();
      for (const name of ['送货单', '标签打印']) await expect(modes().getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', String(name === selected));
      const geometry = await modes().evaluate(nav => {
        const bounds = nav.getBoundingClientRect(), style = getComputedStyle(nav);
        const available = bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth) - parseFloat(style.columnGap || '0');
        return { width: bounds.width, height: bounds.height, available, buttons: [...nav.querySelectorAll('button')].map(control => {
          const rect = control.getBoundingClientRect(), buttonStyle = getComputedStyle(control);
          return { name: control.textContent, width: rect.width, height: rect.height, fontSize: parseFloat(buttonStyle.fontSize), radius: parseFloat(buttonStyle.borderRadius), borderWidth: parseFloat(buttonStyle.borderTopWidth), background: buttonStyle.backgroundColor, selected: control.getAttribute('aria-pressed') === 'true' };
        }) };
      });
      assert.equal(geometry.buttons.length, 2, selected + ': exactly two mode controls');
      assert.ok(geometry.available > 0, selected + ': navigation width is measurable');
      for (const control of geometry.buttons) {
        const detail = selected + ': styled, touch-sized, equal-width mode controls: ' + JSON.stringify(geometry);
        assert.ok(control.height >= 44, detail);
        assert.ok(Math.abs(control.width - geometry.available / 2) <= 1.5, detail);
        assert.ok(Math.abs(control.fontSize - 14) <= .1, detail);
        assert.ok(control.radius >= 8 && control.borderWidth === 0, detail);
        assert.equal(control.background, control.selected ? 'rgb(255, 255, 255)' : 'rgba(0, 0, 0, 0)', detail);
      }
      assert.ok(Math.abs(geometry.buttons[0].height - geometry.buttons[1].height) <= 1, 'both modes share the same height');
      layoutEvidence.push({ label: 'mode-controls', selected, viewport: page.viewportSize(), ...geometry });
    };
    const noOverflow = async label => {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), { message: label + ': document fits viewport' }).toBe(true);
      const bounds = await modes().boundingBox();
      assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= page.viewportSize().width + 1, label + ': switch fits viewport');
      assert.ok(await active().evaluate(element => element.scrollWidth <= element.clientWidth + 1), label + ': active page fits viewport');
    };
    const deliveryRemainsVisible = async expectedView => {
      // Taro hide(page, true) adds a shade class from an old navigation timer.
      // An immediate assertion can pass before that timer runs. Keep sampling
      // past its duration+delay, without modifying production DOM or styles.
      const started = Date.now();
      let visibleSince = 0;
      await expect.poll(async () => {
        const visible = await page.evaluate(view => {
          const container = [...document.querySelectorAll('.taro_page')].find(element => element.id.replace(/^\//, '').split('?')[0] === 'pages/print-center/index');
          if (!container) return false;
          const rect = container.getBoundingClientRect(), style = getComputedStyle(container);
          const main = container.querySelector('main');
          return !container.classList.contains('taro_page_shade') && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0 && main?.getAttribute('data-print-view') === view;
        }, expectedView);
        const now = Date.now();
        if (!visible) visibleSince = 0;
        else if (!visibleSince) visibleSince = now;
        return visible && now - started >= 1100 && now - visibleSince >= 650;
      }, { message: 'return to ' + expectedView + ' stays visible beyond delayed Taro hide timer', timeout: 6000, intervals: [50, 80, 100] }).toBe(true);
      await expect(active().locator('main')).toHaveAttribute('data-print-view', expectedView);
      await expectModes('送货单');
    };
    const actionsRemainBelowForm = async label => {
      const main = active().locator('main');
      await main.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(button('保存单据')).toBeVisible();
      await expect(button('确认出库并打印')).toBeVisible();
      const layout = await main.evaluate(element => {
        const form = element.querySelector('fieldset'), footer = element.querySelector('footer');
        const formRect = form.getBoundingClientRect(), rect = footer.getBoundingClientRect(), mainRect = element.getBoundingClientRect();
        const style = getComputedStyle(element), padding = parseFloat(style.paddingBottom);
        return {
          position: getComputedStyle(footer).position, top: rect.top, bottom: rect.bottom, formBottom: formRect.bottom,
          paddingBottom: padding, scrollPaddingBottom: parseFloat(style.scrollPaddingBottom), safeBottom: Math.min(innerHeight, mainRect.bottom) - padding,
          buttons: [...footer.querySelectorAll('button')].map(control => {
            const bounds = control.getBoundingClientRect(), hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
            return { name: control.textContent, top: bounds.top, bottom: bounds.bottom, hit: hit === control || control.contains(hit) };
          }),
        };
      });
      assert.equal(layout.position, 'static', label + ': actions stay in document flow');
      assert.ok(layout.top >= layout.formBottom, label + ': footer follows all fields: ' + JSON.stringify(layout));
      assert.ok(layout.paddingBottom >= 102, label + ': dock space remains reserved');
      assert.ok(layout.scrollPaddingBottom >= layout.paddingBottom, label + ': scroll-into-view uses safe dock inset');
      assert.ok(layout.buttons.every(control => control.top >= 0 && control.bottom <= layout.safeBottom + 1 && control.hit), label + ': both action buttons are above the dock and genuinely clickable: ' + JSON.stringify(layout));
      layoutEvidence.push({ label, viewport: page.viewportSize(), ...layout });
      await page.screenshot({ path: path.join(artifacts, label + '-safe-actions.png') });
    };
    const labelAndBack = async expectedView => {
      await expectModes('送货单');
      await modes().getByRole('button', { name: '标签打印', exact: true }).click();
      await page.waitForURL(/pages\/label-print\/index/);
      await expectModes('标签打印');
      await expect(active().getByText('电脑 USB 打印 K3', { exact: true })).toBeVisible();
      await expect(active().getByText('70 × 100 mm · 手机不连接蓝牙', { exact: true })).toBeVisible();
      await expect(active().locator('nav[aria-label="打印类型"]').locator('button')).toHaveCount(2);
      await noOverflow('label mode');
      await modes().getByRole('button', { name: '送货单', exact: true }).click();
      await page.waitForURL(/pages\/print-center\/index/);
      await deliveryRemainsVisible(expectedView);
    };

    await page.goto(webOrigin + '/#/pages/print-center/index');
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await expect(button('新建送货单')).toBeVisible();
    await expectModes('送货单');
    await page.screenshot({ path: path.join(artifacts, 'home-modes.png') });
    await labelAndBack('home');
    checks.push('home switches to official label page and returns');

    await button('新建送货单').click();
    await active().getByLabel('收货单位', { exact: true }).fill('草稿往返测试客户');
    await active().getByLabel('收货地址', { exact: true }).fill('草稿保留地址 21 号');
    await active().getByLabel('收货人', { exact: true }).fill('张师傅');
    await active().getByLabel('联系电话', { exact: true }).fill('13800138000');
    await active().getByLabel('送货日期', { exact: true }).fill('2026-10-21');
    await active().getByLabel('送货人', { exact: true }).fill('李师傅');
    await field(1, '产品名称').fill('五层纸箱'); await field(1, '规格尺寸').fill('302015');
    await field(1, '数量').fill('120'); await field(1, '单价').fill('3.50'); await field(1, '备注').fill('第一件未保存草稿');
    await button('＋ 添加货物').click();
    await field(2, '产品名称').fill('三层纸箱'); await field(2, '规格尺寸').fill('251810');
    await field(2, '数量').fill('80'); await field(2, '单价').fill('2.25'); await field(2, '备注').fill('第二件未保存草稿');
    await expect(field(1, '规格尺寸')).toHaveValue('30×20×15');
    await expect(field(2, '规格尺寸')).toHaveValue('25×18×10');
    await actionsRemainBelowForm('draft');
    checks.push('save and outbound actions follow the form and stay hittable above dock');
    const draftBefore = await active().locator('main input').evaluateAll(inputs => inputs.map(input => [input.getAttribute('aria-label'), input.value]));
    await labelAndBack('edit');
    assert.deepEqual(await active().locator('main input').evaluateAll(inputs => inputs.map(input => [input.getAttribute('aria-label'), input.value])), draftBefore, 'all customer, date, delivery and two-item draft fields survive label round trip');
    await expect(active().getByRole('dialog', { name: '保留未保存内容' })).toHaveCount(0);
    await expect(active().locator('input[aria-label$="项产品名称"]')).toHaveCount(2);
    await expect(button('保存单据')).toBeEnabled();
    await actionsRemainBelowForm('returned-draft');
    await page.screenshot({ path: path.join(artifacts, 'edit-draft-preserved.png') });
    checks.push('unsaved customer and two-item draft preserved without discard prompt');

    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await noOverflow('edit ' + width);
      await modes().getByRole('button', { name: '标签打印', exact: true }).click();
      await page.waitForURL(/pages\/label-print\/index/);
      await expectModes('标签打印');
      await noOverflow('label ' + width);
      if (width === 320) await page.screenshot({ path: path.join(artifacts, 'label-modes-320.png') });
      await modes().getByRole('button', { name: '送货单', exact: true }).click();
      await page.waitForURL(/pages\/print-center\/index/);
      await deliveryRemainsVisible('edit');
      await noOverflow('returned edit ' + width);
      assert.deepEqual(await active().locator('main input').evaluateAll(inputs => inputs.map(input => [input.getAttribute('aria-label'), input.value])), draftBefore, 'complete draft retained after repeated round trip at width ' + width);
    }
    checks.push('edit and label switches fit 320, 375, 390 and 430 pixel viewports');
    checks.push('delivery and label modes have 44px touch targets, equal halves and 14px styled text');
    checks.push('repeated returns remain visible beyond delayed Taro shade timer');
    await page.setViewportSize({ width: 390, height: 844 });

    await button('历史单据').click();
    await expect(active().getByLabel('搜索历史单据')).toBeVisible();
    await labelAndBack('history');
    await expect(active().getByLabel('搜索历史单据')).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'history-modes.png') });
    // Opening another note explicitly discards only this in-memory test draft.
    await active().getByRole('button', { name: /模式回归客户（仅本机）.*查看详情/ }).click();
    const discard = active().getByRole('dialog', { name: '保留未保存内容' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: '放弃并继续', exact: true }).click();
    await expect(active().getByRole('heading', { name: '单据详情', exact: true })).toBeVisible();
    await labelAndBack('detail');
    await expect(active().getByRole('heading', { name: '单据详情', exact: true })).toBeVisible();
    await expect(active().getByText(note.number + ' · ' + note.date, { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'detail-modes.png') });
    checks.push('history and saved detail retain their view through label switch');

    const direct = await context.newPage();
    direct.setDefaultTimeout(15000); direct.on('pageerror', error => errors.push(error.message));
    await direct.goto(webOrigin + '/#/pages/label-print/index');
    const directModes = direct.getByRole('navigation', { name: '打印类型', exact: true });
    await expect(directModes.getByRole('button', { name: '标签打印', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await directModes.getByRole('button', { name: '送货单', exact: true }).click();
    await direct.waitForURL(/pages\/print-center\/index/);
    await expect(direct.getByRole('button', { name: '新建送货单', exact: true })).toBeVisible();
    const fallbackStarted = Date.now();
    await expect.poll(async () => {
      const visible = await direct.getByRole('button', { name: '新建送货单', exact: true }).isVisible();
      return visible && Date.now() - fallbackStarted >= 1100;
    }, { message: 'direct label fallback stays visible beyond router timer', timeout: 6000, intervals: [50, 100] }).toBe(true);
    assert.ok(await direct.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'direct label fallback fits narrow viewport');
    await direct.screenshot({ path: path.join(artifacts, 'direct-label-fallback.png') });
    await direct.close();
    checks.push('direct label route falls back to print center without a previous page');

    const nativeContext = await browser.newContext(options);
    await installFixture(nativeContext, webOrigin, true);
    const nativePage = await nativeContext.newPage();
    nativePage.setDefaultTimeout(15000); nativePage.on('pageerror', error => errors.push(error.message));
    await nativePage.goto(webOrigin + '/#/pages/label-print/index');
    await nativePage.locator('taro-button-core').filter({ hasText: /^切换手机蓝牙打印$/ }).click();
    await expect(nativePage.getByText('测试原生状态：K3 真机尚未完成验收，正式打印保持关闭。', { exact: true })).toBeVisible();
    await expect(nativePage.getByText('正式打印等待 K3 验收', { exact: true })).toHaveAttribute('disabled');
    await expect(nativePage.getByText('打印机设置', { exact: true })).toBeVisible();
    assert.equal(await nativePage.evaluate(() => window.__printModesNativeCalls.some(call => ['printLabel', 'printCalibration'].includes(call.method))), false, 'mode navigation does not issue native print commands');
    await nativePage.screenshot({ path: path.join(artifacts, 'native-production-gate.png') });
    await nativeContext.close();
    checks.push('mocked iOS bridge preserves production gate instead of claiming printable');

    assert.deepEqual(unexpected, [], 'all APIs known and every business write blocked');
    assert.deepEqual(errors, [], 'no browser runtime errors');
    assert.equal(requests.filter(item => !['GET', 'OPTIONS'].includes(item.method) && item.path !== '/api/auth/guest').length, 0, 'navigation never changes inventory, bills or notes');
    console.log(JSON.stringify({ browser: engine, assets: webOrigin, checks, API: 'all origins intercepted with in-memory fixtures; no live writes', physicalPrintingTested: false, artifacts }, null, 2));
  } catch (error) {
    failure = error.stack || String(error);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
      const layout = await page.evaluate(() => ({ hash: location.hash, viewport: [innerWidth, innerHeight], elements: [...document.querySelectorAll('.taro_page,main,nav[aria-label="打印类型"]')].map(element => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return { tag: element.tagName, id: element.id, classes: element.className, display: style.display, visibility: style.visibility, opacity: style.opacity, contentVisibility: style.contentVisibility, transform: style.transform, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }; }) })).catch(() => null);
      fs.writeFileSync(path.join(artifacts, 'failure-layout.json'), JSON.stringify(layout, null, 2));
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), browser: engine, assets: process.env.PRINT_WEB_ORIGIN || webRoot, checks, passed: !failure, failure, requests, unexpected, errors, layoutEvidence, API: 'all origins intercepted with in-memory fixtures; no live writes', physicalPrintingTested: false }, null, 2));
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
