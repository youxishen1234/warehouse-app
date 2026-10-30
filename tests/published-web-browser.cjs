const assert = require('node:assert/strict');
const https = require('node:https');
const { chromium, expect } = require('@playwright/test');

function fetchIPv4(url, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: options?.method || 'GET', family: 4, agent: false, timeout: 30000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(new Response(options?.method === 'HEAD' ? null : Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.on('timeout', () => request.destroy(new Error('Published endpoint IPv4 request timed out')));
    request.on('error', reject);
    request.end();
  });
}

async function fetchWithRetry(url, options) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetch(url, { ...options, signal: AbortSignal.timeout(30000) }); }
    catch (error) {
      if (attempt === 2) return fetchIPv4(url, options);
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
}

async function main() {
  const origin = new URL(process.env.PUBLISHED_WEB_ORIGIN || 'https://youxishen.online').origin;
  const expected = process.env.RELEASE_COMMIT;
  assert.match(expected || '', /^[a-f0-9]{40,64}$/, 'The published source revision is required');
  if (new URL(origin).hostname === 'youxishen.online') {
    const alternate = await fetchWithRetry('https://www.youxishen.online/mobile.html', { method: 'HEAD', redirect: 'manual' });
    assert.equal(alternate.status, 308, 'Alternate hostname must use the canonical application origin');
    assert.equal(alternate.headers.get('location'), origin + '/mobile.html');
  }
  for (const route of ['/appupdate/manifest.json', '/release-info.json']) {
    const response = await fetchWithRetry(origin + route, { cache: 'no-store' });
    assert.equal(response.status, 200, route);
    assert.equal((await response.json()).commit, expected, route + ' must match the released source');
  }
  for (const route of ['/workspace/', '/web-releases/', '/web-releases/old/index.html', '/web-current/index.html', '/print.html', '/customers.html', '/management.html', '/legacy-entry.js', '/pages/ledger/index', '/pages/board-stock/index']) {
    const response = await fetchWithRetry(origin + route, { method: 'HEAD', cache: 'no-store' });
    assert.equal(response.status, 410, route + ' must no longer serve a legacy interface');
  }
  for (const route of ['/js/home-search.js', '/css/polish.css', '/js/app.fba72e6a.js']) {
    const response = await fetchWithRetry(origin + route, { method: 'HEAD', cache: 'no-store' });
    assert.equal(response.status, 404, route + ' must not fall back to old shared assets');
  }
  for (const route of ['/embed/', '/embed/pages/management/index?section=labels', '/pages/management/index?section=labels']) {
    const response = await fetchWithRetry(origin + route, { method: 'HEAD', cache: 'no-store' });
    assert.equal(response.status, 200, route);
    const policy = response.headers.get('content-security-policy') || '';
    if (route.startsWith('/embed/')) {
      assert.match(policy, /frame-ancestors 'self' app:/, route);
      assert.doesNotMatch(policy, /frame-ancestors 'none'/, route);
      assert.equal(response.headers.get('x-frame-options'), null, route);
    } else {
      assert.match(policy, /frame-ancestors 'none'/, route);
      assert.equal(response.headers.get('x-frame-options'), 'DENY', route);
    }
  }
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const writes = [], connections = [], errors = [];
    const automaticPrinter = {
      client: 'c'.repeat(64),
      device: { id: 'published-ui-local-default', name: '隔离验证打印电脑', printer: 'EPSON LQ-630K', online: true, ready: true }
    };
    await context.route('**/api/**', route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/remote-print/connect' && request.method() === 'POST') {
        const body = request.postDataJSON();
        assert.deepEqual(body, {}, 'automatic discovery accepts no connection code or business payload');
        connections.push(body);
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ success: true, data: automaticPrinter }) });
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname !== '/api/auth/guest') {
        writes.push(request.method() + ' ' + pathname);
        return route.abort();
      }
      let data = [];
      if (pathname === '/api/remote-print/device' && request.method() === 'GET') {
        assert.equal(request.headers()['x-print-client'], automaticPrinter.client);
        data = automaticPrinter.device;
      }
      if (pathname.endsWith('/auth/guest')) data = { token: 'published-ui-check', user: { id: 1, username: '界面验证', role: 'viewer' } };
      if (pathname.endsWith('/sync')) data = { revision: 1 };
      if (pathname.endsWith('/stats')) data = { todayIn: 0, todayOut: 0, totalProducts: 0, totalStock: 0, lowStock: 0, totalValue: 0 };
      if (pathname.endsWith('/print-notes')) data = { items: [], total: 0, page: 1, page_size: 30 };
      if (pathname.includes('dimensions')) data = { schemaVersion: 1, revision: 0, customers: [], inactiveCustomerNames: [], theme: {} };
      return route.fulfill({ status: request.method() === 'OPTIONS' ? 204 : 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    });
    await context.addInitScript(() => localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true })));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/mobile.html');
    const frame = page.frameLocator('#mobile-app');
    await expect(frame.getByTestId('workbench-business-flow')).toBeVisible({ timeout: 30000 });
    await frame.locator('.sg-app-nav [data-tab="2"]').click();
    await expect(frame.locator('[data-testid="simple-workbench"][data-panel="stock"]')).toBeVisible();
    await frame.locator('.sg-app-nav [data-tab="3"]').click();
    await expect(frame.getByRole('button', { name: '选择出库单', exact: true })).toBeVisible();
    await expect(frame.getByRole('button', { name: '新建送货单', exact: true })).toBeVisible();
    await expect(frame.getByRole('heading', { name: '最近单据', exact: true })).toBeVisible();
    await frame.getByRole('button', { name: '对账单', exact: true }).click();
    await expect(frame.getByLabel('选择对账单位')).toBeVisible();
    await frame.locator('.sg-app-nav [data-tab="4"]').click();
    await expect(frame.getByText('我的工作空间', { exact: true })).toBeVisible();
    for (const [route, testId] of [
      ['customer-orders/index?create=1', 'customer-order-sheet'],
      ['board-inbound/index', 'paperboard-receipt-sheet'],
      ['carton-inbound/index', 'carton-receipt-sheet'],
      ['production-inbound/index', 'production-receipt-sheet']
    ]) {
      await frame.locator('body').evaluate((_, value) => { location.hash = '/pages/' + value; }, route);
      const sheet = frame.getByTestId(testId);
      await expect(sheet).toBeVisible();
      const geometry = await sheet.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, overflow: el.scrollWidth > el.clientWidth + 1 }; });
      assert.ok(geometry.x >= -1 && geometry.right <= geometry.viewportWidth + 1 && geometry.y >= 0 && geometry.bottom <= geometry.viewportHeight + 1 && !geometry.overflow, route + ': ' + JSON.stringify(geometry));
    }
    assert.deepEqual(writes, [], 'Online verification must never change business data');
    assert.ok(connections.length > 0, 'automatic connection is fulfilled locally without contacting the print service');
    assert.deepEqual(errors, []);
    console.log('PASS: published source revision, public framing headers, homepage, inventory, print modes Mine UI and four new responsive business routes');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
