const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const origin = new URL(process.env.PUBLISHED_WEB_ORIGIN || 'https://youxishen.online').origin;
  const expected = process.env.RELEASE_COMMIT;
  assert.match(expected || '', /^[a-f0-9]{40,64}$/, 'The published source revision is required');
  for (const route of ['/appupdate/manifest.json', '/release-info.json']) {
    const response = await fetch(origin + route, { cache: 'no-store' });
    assert.equal(response.status, 200, route);
    assert.equal((await response.json()).commit, expected, route + ' must match the released source');
  }
  for (const route of ['/embed/', '/embed/pages/label-print/index', '/pages/label-print/index']) {
    const response = await fetch(origin + route, { method: 'HEAD', cache: 'no-store' });
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
    await expect(frame.getByTestId('workbench-business-flow')).toBeVisible({ timeout: 30000 });
    await expect(frame.getByTestId('workbench-sync-status')).toContainText('服务器数据已读取', { timeout: 30000 });
    await frame.locator('.sg-glass-items [data-tab="2"]').click();
    await expect(frame.locator('[data-testid="simple-workbench"][data-panel="stock"]')).toBeVisible();
    await frame.locator('.sg-glass-items [data-tab="3"]').click();
    await expect(frame.getByRole('button', { name: '从出库单自动开单', exact: true })).toBeVisible();
    await expect(frame.getByText('手动填写送货单', { exact: true })).toBeVisible();
    await expect(frame.getByRole('heading', { name: '我的单据', exact: true })).toBeVisible();
    assert.deepEqual(writes, [], 'Online verification must never change business data');
    assert.deepEqual(errors, []);
    console.log('PASS: published source revision, public framing headers, mobile homepage, live data, inventory and automatic/manual printing');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
