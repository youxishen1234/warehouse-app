const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');

async function gotoWithRetry(page, url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      if (attempt === 5 || !/ERR_(?:CONNECTION|TIMED_OUT|NETWORK|NAME|SSL|CERT)|navigation timeout|ECONNRESET/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}

async function visit(page, url) {
  const response = await gotoWithRetry(page, url);
  assert.ok(response, `No document response for ${url}`);
  return { response, status: response.status(), headers: await response.allHeaders() };
}

function isTransientNetworkError(error) {
  return /ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|TIMED_OUT|NETWORK|NAME|SSL|CERT)|ECONNRESET|ETIMEDOUT/i.test(error?.message || '');
}

async function waitForFrame(page, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = page.frames().find(predicate);
    if (frame) return frame;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The published mobile application frame did not load');
}

async function main() {
  const origin = new URL(process.env.PUBLISHED_WEB_ORIGIN || 'https://youxishen.online').origin;
  const expected = process.env.RELEASE_COMMIT;
  assert.match(expected || '', /^[a-f0-9]{40,64}$/, 'The published source revision is required');
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const writes = [], errors = [];
    await context.route('**/api/**', route => {
      const request = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || new URL(request.url()).pathname === '/api/auth/guest') return route.continue();
      writes.push(request.method() + ' ' + new URL(request.url()).pathname);
      return route.abort();
    });
    const probe = await context.newPage();
    for (const route of ['/appupdate/manifest.json', '/release-info.json']) {
      const { response, status } = await visit(probe, origin + route);
      assert.equal(status, 200, route);
      assert.equal((await response.json()).commit, expected, route + ' must match the released source');
    }
    for (const route of ['/workspace/', '/web-releases/', '/web-releases/old/index.html', '/web-current/index.html', '/print.html', '/customers.html', '/management.html', '/legacy-entry.js', '/pages/ledger/index', '/pages/board-stock/index']) {
      const { status } = await visit(probe, origin + route);
      assert.equal(status, 410, route + ' must no longer serve a legacy interface');
    }
    for (const route of ['/js/home-search.js', '/css/polish.css', '/js/app.fba72e6a.js']) {
      const { status } = await visit(probe, origin + route);
      assert.equal(status, 404, route + ' must not fall back to old shared assets');
    }
    for (const route of ['/embed/', '/preview-pages/index.html', '/pages/home/index']) {
      const { status, headers } = await visit(probe, origin + route);
      assert.equal(status, 200, route);
      const policy = headers['content-security-policy'] || '';
      if (route.startsWith('/embed/') || route.startsWith('/preview-pages/')) {
        assert.match(policy, /frame-ancestors 'self' app:/, route);
        assert.doesNotMatch(policy, /frame-ancestors 'none'/, route);
        assert.equal(headers['x-frame-options'], undefined, route);
      } else {
        assert.match(policy, /frame-ancestors 'none'/, route);
        assert.equal(headers['x-frame-options'], 'DENY', route);
      }
    }
    await probe.close();
    await context.addInitScript(() => localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true })));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /Content Security Policy|violates the following Content Security Policy/i.test(message.text())) errors.push(message.text());
    });
    await gotoWithRetry(page, origin + '/mobile.html');
    const frame = await waitForFrame(page, candidate => candidate.url().includes('/preview-pages/index.html'));
    const orderButton = frame.getByRole('button', { name: '＋ 客户开单', exact: true });
    await expect(orderButton).toBeVisible({ timeout: 30000 });
    await expect(frame.getByRole('button', { name: '库存', exact: true })).toBeVisible();
    await orderButton.click();
    await expect(frame.getByRole('dialog').getByRole('heading', { name: '客户开单', exact: true })).toBeVisible();
    await frame.getByRole('button', { name: '关闭', exact: true }).click();
    for (const [pathname, heading] of [
      ['/preview-pages/customers.html', '客户管理'],
      ['/preview-pages/management.html?view=stock', '库存管理'],
      ['/preview-pages/management.html?view=finance', '收付款'],
      ['/preview-pages/management.html?view=suppliers', '供货商管理'],
      ['/preview-pages/print.html', '打印中心']
    ]) {
      const view = await context.newPage();
      view.on('pageerror', error => errors.push(error.message));
      view.on('console', message => {
        if (message.type() === 'error' && /Content Security Policy|violates the following Content Security Policy/i.test(message.text())) errors.push(message.text());
      });
      await gotoWithRetry(view, origin + pathname);
      await expect(view.getByRole('heading', { name: heading, exact: true })).toBeVisible({ timeout: 30000 });
      await view.close();
    }
    assert.deepEqual(writes, [], 'Online verification must never change business data');
    assert.deepEqual(errors, []);
    console.log('PASS: published source revision, public framing headers and six-view mobile business console');
  } catch (error) {
    if (process.env.WAREHOUSE_PUBLISHED_BROWSER_ALLOW_NETWORK_SKIP === '1' && isTransientNetworkError(error)) {
      console.warn(`SKIP: published browser probe is unreachable from this runner: ${error.message.split('\n')[0]}`);
      return;
    }
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
