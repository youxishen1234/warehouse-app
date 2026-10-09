const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { parseDateQuery } = require('../backend/date-query');

const root = path.resolve(process.env.LEDGER_WEB_DIR || 'dist');
const artifacts = path.resolve('release/ledger-check');
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const filename = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || fs.statSync(filename).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(res);
});

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Shanghai' });
    await page.clock.setFixedTime(new Date('2026-10-03T08:00:00+08:00'));
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let failLoad = false;
    let failWrite = false;
    let slowNextLoad = false;
    let writes = 0;
    let rows = [
      { id: 106, type: 'income', amount: 12800, party_name: '华丰包装', party_current_name: '华丰包装有限公司', party_id: 1, remark: '10 月纸箱货款', created_at: Date.parse('2026-10-03T07:30:00+08:00') },
      { id: 105, type: 'expense', amount: 680, remark: '纸板运输费', created_at: Date.parse('2026-10-03T07:00:00+08:00') },
      { id: 104, type: 'receivable', amount: 8600, party_name: '新星食品', party_id: 2, transaction_id: 42, remark: '五层瓦楞纸箱 · 2,000 个', created_at: Date.parse('2026-10-02T16:40:00+08:00') },
      { id: 103, type: 'expense', amount: 4320, party_name: '恒源纸业', remark: '原纸采购', created_at: Date.parse('2026-10-02T14:20:00+08:00') },
      { id: 102, type: 'payable', amount: 6200, party_name: '恒源纸业', party_id: 3, delivery_note_id: 24, remark: '纸板来货月结', created_at: Date.parse('2026-10-02T10:00:00+08:00') },
      { id: 101, type: 'settlement', amount: 3500, party_name: '晨光商贸', party_id: 4, remark: '9 月往来结清', created_at: Date.parse('2026-10-01T17:30:00+08:00') },
      { id: 100, type: 'income', amount: 3500, party_name: '晨光商贸', remark: '纸箱现结货款', created_at: Date.parse('2026-10-01T15:30:00+08:00') },
      { id: 99, type: 'income', amount: 9900, remark: '上月记录', created_at: Date.parse('2026-09-30T23:59:59+08:00') }
    ];
    const matching = url => rows.filter(row => !row.voided_at && (!url.searchParams.get('type') || row.type === url.searchParams.get('type')) &&
      (!url.searchParams.get('keyword') || `${row.party_name || ''} ${row.remark || ''}`.toLowerCase().includes(url.searchParams.get('keyword').toLowerCase())) &&
      (!url.searchParams.has('from') || row.created_at >= parseDateQuery(url.searchParams.get('from'))) &&
      (!url.searchParams.has('to') || row.created_at <= parseDateQuery(url.searchParams.get('to'), true)));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (!url.pathname.startsWith('/api/')) return route.abort();
      const method = route.request().method();
      let data = {};
      if (url.pathname.endsWith('/auth/guest')) data = { token: 'isolated-ledger-preview', user: { id: 'preview', username: 'preview', role: 'operator' } };
      else if (url.pathname === '/api/ledger' && method === 'POST') {
        writes += 1;
        if (failWrite) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试保存失败，请重试' }) });
        data = { ...route.request().postDataJSON(), id: 107, created_at: Date.parse('2026-10-03T08:00:00+08:00') };
        rows.push(data);
      } else if (url.pathname.startsWith('/api/ledger/') && method === 'DELETE') {
        data = rows.find(row => row.id === Number(url.pathname.split('/').pop()));
        data.voided_at = Date.now();
      } else if (url.pathname === '/api/ledger') {
        const result = matching(url);
        if (failLoad) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试连接中断' }) });
        if (slowNextLoad) { slowNextLoad = false; await new Promise(resolve => setTimeout(resolve, 500)); }
        data = result;
      } else if (url.pathname === '/api/export/ledger.csv') {
        return route.fulfill({ status: 200, contentType: 'text/csv', body: '\ufeff类型,金额,备注\r\n' + matching(url).map(row => `${row.type},${row.amount},${row.remark}`).join('\r\n') });
      } else if (url.pathname === '/api/sync') data = { revision: 1 };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    });

    const rowButtons = page.locator('[class*="__item___"]');
    const typeTabs = page.locator('[class*="__typeTabs___"]');
    const sheet = page.locator('[class*="__sheet___"]');
    const search = page.locator('input[placeholder="搜索客户、供应商或备注"]');
    await page.goto(`${origin}/#/pages/ledger/index`);
    await expect(rowButtons).toHaveCount(7);
    await expect(page.locator('[class*="__netAmount___"]')).toHaveText('¥11,300.00');
    await rowButtons.first().locator('img').first().waitFor({ state: 'visible' });
    await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
    await page.screenshot({ path: path.join(artifacts, 'ledger-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(artifacts, 'ledger-desktop.png') });
    await page.setViewportSize({ width: 320, height: 740 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at 320 px');
    await page.screenshot({ path: path.join(artifacts, 'ledger-small.png') });
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByRole('button', { name: '筛选应收流水', exact: true }).click();
    await expect(rowButtons).toHaveCount(1);
    await expect(rowButtons.first()).toContainText('出库应收');
    await expect(typeTabs.getByRole('button', { name: '应收', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: path.join(artifacts, 'ledger-receivable.png') });
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await expect(rowButtons).toHaveCount(7);

    await typeTabs.getByRole('button', { name: '收入', exact: true }).click();
    await expect(rowButtons).toHaveCount(2);
    await search.fill('华丰');
    await expect(rowButtons).toHaveCount(1);
    await expect(page.locator('[class*="__netAmount___"]')).toHaveText('¥11,300.00');
    const downloadEvent = page.waitForEvent('download');
    const exportRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/export/ledger.csv');
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    const requestUrl = new URL((await exportRequest).url());
    assert.equal(requestUrl.searchParams.get('type'), 'income');
    assert.equal(requestUrl.searchParams.get('keyword'), '华丰');
    assert.equal(new Date(Number(requestUrl.searchParams.get('to'))).getHours(), 0);
    const download = await downloadEvent;
    await download.saveAs(path.join(artifacts, 'ledger.csv'));
    assert.equal(fs.readFileSync(path.join(artifacts, 'ledger.csv'), 'utf8').split('\r\n').length, 2);

    await rowButtons.first().click();
    await expect(sheet.getByText('华丰包装有限公司', { exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: '作废流水' })).toHaveCount(0);
    await sheet.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
    await page.screenshot({ path: path.join(artifacts, 'ledger-detail.png') });
    await page.getByRole('button', { name: '关闭流水详情' }).click();
    await search.fill('不存在的对象');
    await expect(page.getByText('没有找到匹配的流水', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(rowButtons).toHaveCount(7);

    await typeTabs.getByRole('button', { name: '结清', exact: true }).click();
    await expect(rowButtons).toHaveCount(1);
    await expect(rowButtons.first().locator('[class*="__itemAmount___"]')).toHaveText('¥3,500.00');
    await typeTabs.getByRole('button', { name: '全部', exact: true }).click();
    await page.getByRole('button', { name: '上月', exact: true }).click();
    await expect(rowButtons).toHaveCount(1);
    await expect(rowButtons.first()).toContainText('上月记录');
    slowNextLoad = true;
    await page.getByRole('button', { name: '本月', exact: true }).click();
    await page.getByRole('button', { name: '全部时间', exact: true }).click();
    await expect(rowButtons).toHaveCount(8);
    await new Promise(resolve => setTimeout(resolve, 600));
    await expect(rowButtons).toHaveCount(8);
    await page.getByRole('button', { name: '选日期', exact: true }).click();
    await page.getByRole('button', { name: '应用日期' }).click();
    await expect(page.getByText('请选择开始日期和结束日期', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭日期筛选' }).click();

    // Use the actual date picker controls and verify that the filter is applied.
    await page.getByRole('button', { name: '本月', exact: true }).click();
    await expect(rowButtons).toHaveCount(7);
    await page.getByRole('button', { name: '选日期', exact: true }).click();
    const dateFields = sheet.locator('[class*="__datePicker___"]');
    await dateFields.first().click();
    await page.locator('.weui-picker__action:visible').filter({ hasText: '确定' }).click();
    await dateFields.last().click();
    await page.locator('.weui-picker__action:visible').filter({ hasText: '确定' }).click();
    await page.getByRole('button', { name: '应用日期' }).click();
    await expect(page.getByText('自定义收支净额', { exact: true })).toBeVisible();
    await expect(rowButtons).toHaveCount(7);

    await page.getByRole('button', { name: '上月', exact: true }).click();
    await expect(rowButtons).toHaveCount(1);
    await page.locator('[class*="__bottomBar___"]').getByRole('button', { name: '记一笔' }).click();
    await sheet.getByRole('button', { name: '支出', exact: true }).click();
    await sheet.getByRole('button', { name: '运输费', exact: true }).click();
    await expect(page.locator('input[placeholder="例如：客户货款、运费、日常采购"]')).toHaveValue('运输费');
    await page.locator('input[placeholder="0.00"]').fill('12.345');
    await expect(page.locator('input[placeholder="0.00"]')).toHaveValue('12.34');
    await page.locator('input[placeholder="例如：客户货款、运费、日常采购"]').fill('测试运费');
    assert.equal(await sheet.getByRole('button', { name: '保存流水', exact: true }).evaluate(element => getComputedStyle(element).opacity), '1');
    await page.screenshot({ path: path.join(artifacts, 'ledger-add.png') });
    failWrite = true;
    await page.getByRole('button', { name: '保存流水', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存流水', exact: true })).toBeEnabled();
    await expect(page.locator('input[placeholder="0.00"]')).toHaveValue('12.34');
    failWrite = false;
    await page.getByRole('button', { name: '保存流水', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(rowButtons).toHaveCount(8);
    await expect(rowButtons.filter({ hasText: '测试运费' })).toHaveCount(1);
    await expect(page.locator('[class*="__netAmount___"]')).toHaveText('¥11,287.66');
    assert.equal(writes, 2, 'one failed write and one successful retry');

    await rowButtons.filter({ hasText: '测试运费' }).click();
    await page.getByRole('button', { name: '作废流水', exact: true }).click();
    await page.getByText('取消', { exact: true }).click();
    await expect(sheet).toHaveCount(1);
    await page.getByRole('button', { name: '作废流水', exact: true }).click();
    await page.getByText('确认作废', { exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(rowButtons).toHaveCount(7);
    await expect(page.locator('[class*="__netAmount___"]')).toHaveText('¥11,300.00');

    failLoad = true;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByText('账单暂时没有加载成功', { exact: true })).toBeVisible();
    await expect(page.locator('[class*="__netAmount___"]')).toHaveText('—');
    await expect(page.getByRole('button', { name: '导出 CSV', exact: true })).toBeDisabled();
    failLoad = false;
    await page.getByRole('button', { name: '重新加载' }).click();
    await expect(rowButtons).toHaveCount(7);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ summary: 'passed', filtersAndExport: 'passed', linkedEntryProtection: 'passed', failedSaveRetry: 'passed', addAndVoid: 'passed', staleResponse: 'passed', loadFailureRetry: 'passed', viewports: [320, 390, 1440], pageErrors: errors }));
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(artifacts, 'failure.png') }); console.error((await page.locator('body').innerText()).slice(0, 2000)); }
    throw error;
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
