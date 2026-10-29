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
    await page.goto(origin + '/mobile.html');
    const frame = page.frameLocator('#mobile-app');
    await expect(frame.getByRole('heading', { name: '业务总台', exact: true })).toBeVisible({ timeout: 30000 });
    await expect(frame.getByRole('button', { name: '客户开单', exact: true })).toBeVisible();
    await expect(frame.getByRole('link', { name: '库存', exact: true })).toBeVisible();
    assert.deepEqual(writes, [], 'Online verification must never change business data');
    assert.deepEqual(errors, []);
    console.log('PASS: published source revision, public framing headers and six-view mobile business console');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
