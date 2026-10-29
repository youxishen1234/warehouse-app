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
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = attempt < 3
        ? await fetch(url, { ...options, signal: AbortSignal.timeout(30000) })
        : await fetchIPv4(url, options);
      if ([408, 425, 429, 500, 502, 503, 504].includes(response.status) && attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function gotoWithRetry(page, url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      if (attempt === 3 || !/ERR_(?:CONNECTION|TIMED_OUT|NETWORK|NAME|SSL|CERT)|navigation timeout/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
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
  for (const route of ['/embed/', '/preview-pages/index.html', '/pages/home/index']) {
    const response = await fetchWithRetry(origin + route, { method: 'HEAD', cache: 'no-store' });
    assert.equal(response.status, 200, route);
    const policy = response.headers.get('content-security-policy') || '';
    if (route.startsWith('/embed/') || route.startsWith('/preview-pages/')) {
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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const writes = [], errors = [];
    await context.route('**/api/**', route => {
      const request = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || new URL(request.url()).pathname === '/api/auth/guest') return route.continue();
      writes.push(request.method() + ' ' + new URL(request.url()).pathname);
      return route.abort();
    });
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
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
