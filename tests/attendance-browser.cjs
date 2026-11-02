const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const webRoot = path.resolve(process.env.ATTENDANCE_WEB_DIR || process.env.TARO_OUTPUT_DIR || '');
  if (!webRoot || !fs.existsSync(path.join(webRoot, 'index.html'))) throw new Error('ATTENDANCE_WEB_DIR or TARO_OUTPUT_DIR must name a built web app');
  process.env.TEAM_PREVIEW_WEB_DIR = webRoot;
  process.env.TEAM_PREVIEW_PORT = '0';
  const { server } = await require('../scripts/team-preview.cjs')();
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  const evidence = path.resolve('release/attendance-20261101');
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await context.route('https://youxishen.online/api/**', async route => {
      const request = route.request();
      const source = new URL(request.url());
      if (request.method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': '*',
            'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS'
          }
        });
      }
      if (source.pathname === '/api/auth/guest') {
        return route.fulfill({
          status: 200,
          headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { token: 'attendance-browser-check', user: { id: 'attendance-check', username: '考勤验收', role: 'admin' } } })
        });
      }
      const response = await fetch(localOrigin + source.pathname + source.search, {
        method: request.method(),
        headers: request.headers(),
        body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postData() || undefined
      });
      const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'access-control-expose-headers': 'X-Warehouse-Revision',
        'content-type': response.headers.get('content-type') || 'application/json'
      };
      const revision = response.headers.get('x-warehouse-revision');
      if (revision) headers['x-warehouse-revision'] = revision;
      return route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => {
      if (request.url().includes('/api/')) errors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`);
    });
    await page.goto(localOrigin + '/#/pages/mine/index');
    await page.locator('taro-button-core').filter({ hasText: '考勤记录' }).click();
    await page.waitForURL(/section=attendance/);
    await expect(page.getByRole('heading', { name: '考勤', exact: true })).toBeVisible();
    await expect(page.getByText('本月还没有考勤', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /记一笔/ }).first().click();
    await page.getByLabel('员工姓名').fill('张三');
    await page.getByLabel('考勤日期').fill('2026-11-01');
    await page.getByLabel('上班时间').fill('08:00');
    await page.getByLabel('下班时间').fill('17:30');
    await page.getByLabel('加班时长').fill('1.5');
    await page.getByLabel('考勤备注').fill('月底盘点');
    await page.getByRole('button', { name: '保存考勤', exact: true }).click();

    const record = page.getByTestId('attendance-record-1');
    await expect(record).toBeVisible();
    await expect(record.getByText('张三', { exact: true })).toBeVisible();
    await expect(record.getByText('08:00–17:30', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '本月考勤汇总' }).getByText('9.5', { exact: false })).toBeVisible();

    await record.getByRole('button', { name: /编辑 张三/ }).click();
    await page.getByLabel('下班时间').fill('18:00');
    await page.getByLabel('加班时长').fill('2');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(record.getByText('08:00–18:00', { exact: true })).toBeVisible();
    await expect(record.getByText('2h', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '请假', exact: true }).click();
    await expect(page.getByText('这个筛选下没有记录', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await expect(record).toBeVisible();
    await page.waitForTimeout(1800);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(evidence, 'attendance-mobile.png'), fullPage: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await expect(page.getByTestId('attendance-record-1')).toBeVisible();
    const layout = await page.evaluate(() => ({
      pageWidth: document.querySelector('.demo-page')?.getBoundingClientRect().width || 0,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: innerWidth,
      summary: Array.from(document.querySelector('[aria-label="本月考勤汇总"]')?.children || []).map(element => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return { text: element.textContent?.trim().slice(0, 20), width: box.width, height: box.height, minHeight: style.minHeight, alignSelf: style.alignSelf };
      })
    }));
    assert.ok(layout.pageWidth >= 900, `desktop attendance width: ${JSON.stringify(layout)}`);
    assert.ok(layout.scrollWidth <= layout.innerWidth, `desktop horizontal overflow: ${JSON.stringify(layout)}`);
    await page.screenshot({ path: path.join(evidence, 'attendance-desktop.png'), fullPage: true });
    assert.deepEqual(errors, [], 'attendance page should not raise browser errors');
    console.log(JSON.stringify({ pass: true, layout, evidence }));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(path.dirname(process.env.WAREHOUSE_DATA_FILE), { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
