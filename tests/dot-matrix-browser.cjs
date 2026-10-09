const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('../backend/node_modules/express');
const { chromium, webkit, expect } = require('@playwright/test');

const root = path.resolve(process.env.PRINT_WEB_DIR || 'release/dot-matrix-web');
const artifacts = path.resolve('release/dot-matrix-check');
const timestamp = new Date('2026-10-03T10:00:00+08:00').getTime();
const incoming = Array.from({ length: 197 }, (_, i) => ({ id: 1000 - i, product_id: 5, product_name: '入库纸板', supplier_id: 2, supplier_name: '示例纸业', quantity: 20, unit: '张', unit_price: 1.5, amount: 30, remark: '', operator: '仓库', created_at: timestamp + i, type: 'in' }));
const outgoing = Array.from({ length: 12 }, (_, i) => ({ id: 12 - i, product_id: 100 + i, product_name: `纸箱 ${12 - i}`, specification: '40 × 30 × 20 cm', customer_id: 7, customer_name: '华兴包装有限公司', quantity: 100, unit: '个', unit_price: 3.5, amount: 350, remark: i === 5 ? '<img src=x onerror=alert(1)> & 特殊字符' : '货到验收', operator: '陈师傅', outbound_no: 'CK-20261003-001', order_no: 'DD-20261002-008', created_at: timestamp, type: 'out' }));

async function verify(browser, origin, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1250 } });
  const page = await context.newPage();
  const errors = [];
  const writes = [];
  let failRead = false;
  let voided = false;
  let holdRead = null;
  let extra = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'OPTIONS'].includes(route.request().method()) && !url.pathname.endsWith('/auth/guest')) writes.push(url.pathname);
      let data = [];
      let status = 200;
      if (url.pathname.endsWith('/auth/guest')) data = { token: 'print-test-token', user: { id: 'print-test', username: 'print-test', role: 'viewer' } };
      if (url.pathname.endsWith('/sync')) data = { revision: 1 };
      if (url.pathname.endsWith('/health')) data = { status: 'ok' };
      if (url.pathname.endsWith('/stats')) data = { todayIn: 0, todayOut: 0, totalProducts: 0, lowStock: 0, totalValue: 0 };
      if (url.pathname.endsWith('/transactions')) {
        const records = [...incoming, ...outgoing.map(item => ({ ...item, ...(voided ? { voided_at: timestamp + 100 } : {}) })), ...extra];
        if (url.searchParams.has('page')) {
          const number = Number(url.searchParams.get('page'));
          const size = Number(url.searchParams.get('page_size'));
          data = { items: records.slice((number - 1) * size, number * size), total: records.length, page: number, page_size: size };
        } else {
          if (holdRead && url.searchParams.get('type') === 'out') { const hold = holdRead; holdRead = null; hold.started(); await hold.promise; }
          if (failRead) { failRead = false; status = 400; }
          data = records.filter(item => !url.searchParams.has('type') || item.type === url.searchParams.get('type'));
        }
      }
      return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'x-warehouse-revision': '1' }, body: JSON.stringify(status === 200 ? { success: true, data } : { success: false, message: '测试：单据读取失败' }) });
    }
    return url.origin === origin ? route.continue() : route.abort();
  });
  const frame = () => page.frameLocator('iframe[title="针式单据打印预览"]');
  const printButton = () => page.getByRole('button', { name: /^打印本单/ });
  const inspectPages = async () => {
    const counts = await frame().locator('.sheet').evaluateAll(sheets => sheets.map(sheet => ({
      rows: sheet.querySelectorAll('tr[data-line]').length,
      gap: sheet.querySelector('.footer').getBoundingClientRect().top - sheet.querySelector('table').getBoundingClientRect().bottom,
      width: sheet.getBoundingClientRect().width,
      height: sheet.getBoundingClientRect().height,
    })));
    assert.equal(counts.reduce((sum, value) => sum + value.rows, 0), 12, 'print includes all rows across the API page boundary');
    counts.forEach(value => assert.ok(value.gap >= 5, 'footer and table never overlap'));
    return counts;
  };
  const savePdf = async (label, width, height, count) => {
    // Exercise the real print button and top-level page, including the app's layout ancestors.
    // Exporting the iframe HTML to a separate page misses print-origin and preview-transform bugs.
    await page.evaluate(() => { window.print = () => {}; });
    await printButton().click();
    try {
      await page.emulateMedia({ media: 'print' });
      const surface = page.locator('[data-dot-matrix-print-root]');
      const bounds = await surface.boundingBox();
      assert.ok(bounds && Math.abs(bounds.x) < 1 && Math.abs(bounds.y) < 1, 'printing starts at the page origin');
      assert.ok(Math.abs(bounds.width - width * 96 / 25.4) < 1, 'screen preview scale never changes physical print width');
      await expect(surface.locator('.sheet')).toHaveCount(count);
      await expect(surface.locator('tr[data-line]')).toHaveCount(12);
      await expect(page.getByRole('button', { name: '刷新单据', exact: true })).toBeHidden();
      const printedSheets = await surface.locator('.sheet').evaluateAll(sheets => sheets.map(sheet => {
        const paper = sheet.getBoundingClientRect();
        const table = sheet.querySelector('table').getBoundingClientRect();
        const footer = sheet.querySelector('.footer').getBoundingClientRect();
        return { x: paper.x, width: paper.width, tableLeft: table.left - paper.left, tableRight: table.right - paper.left, gap: footer.top - table.bottom };
      }));
      printedSheets.forEach(sheet => {
        assert.ok(Math.abs(sheet.x) < 1 && Math.abs(sheet.width - width * 96 / 25.4) < 1);
        assert.ok(sheet.tableLeft >= 0 && sheet.tableRight <= sheet.width, 'all columns stay inside the physical paper');
        // CSS layout stays inside the physical sheet; native driver printable
        // width is validated separately by the local-renderer check.
        assert.ok(sheet.gap >= 5, 'printed footer never overlaps the table');
      });
      const previewType = await frame().locator('tbody td').first().evaluate(element => {
        const style = getComputedStyle(element); return { font: style.fontFamily, weight: style.fontWeight, size: style.fontSize };
      });
      const printedType = await surface.locator('tbody td').first().evaluate(element => {
        const style = getComputedStyle(element); return { font: style.fontFamily, weight: style.fontWeight, size: style.fontSize };
      });
      assert.deepEqual(printedType, previewType, 'font and weight remain identical when copied outside the preview iframe');
      if (name !== 'chromium') return;
      if (label === '241x140') await surface.locator('.sheet').first().screenshot({ path: path.join(artifacts, 'delivery-note.png') });
      const pdf = await page.pdf({ path: path.join(artifacts, `${label}.pdf`), preferCSSPageSize: true, printBackground: false });
      const text = pdf.toString('latin1');
      assert.equal((text.match(/\/Type\s*\/Page\b/g) || []).length, count, 'one generated sheet per physical page, no blank trailing pages');
      const boxes = [...text.matchAll(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/g)];
      assert.ok(boxes.length);
      for (const box of boxes) { assert.ok(Math.abs(Number(box[1]) - width * 72 / 25.4) < 1); assert.ok(Math.abs(Number(box[2]) - height * 72 / 25.4) < 1); }
    } finally {
      await page.emulateMedia({ media: 'screen' });
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      await expect(page.locator('[data-dot-matrix-print-root]')).toHaveCount(0);
      await expect(page.locator('[data-dot-matrix-print-style]')).toHaveCount(0);
      assert.equal(await page.locator('html').getAttribute('data-dot-matrix-print'), null);
    }
  };
  try {
    await page.goto(origin + '/index.html#/pages/print-center/index');
    await expect(page.getByRole('button', { name: '打印测试样张', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '四格出库单 三等分纸 · 内容可编辑' })).toHaveAttribute('aria-pressed', 'true');
    await expect(frame().locator('h1')).toHaveText('东光县曙光纸箱包装出库单');
    await expect(frame().locator('tbody tr')).toHaveCount(4);
    await page.getByRole('button', { name: '编辑单据', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑四行出库单' });
    const editorSize = await editor.getByLabel('单位', { exact: true }).evaluate(element => ({ height: element.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(element).fontSize) }));
    assert.ok(editorSize.height >= 30 && editorSize.height <= 45 && editorSize.fontSize <= 16, 'editor controls remain compact after Taro transforms native tags');
    await editor.getByLabel('单位', { exact: true }).fill('本次打印客户');
    await editor.getByLabel('第1行名称', { exact: true }).fill('编辑后的五层纸箱');
    await editor.getByLabel('第1行出库数量', { exact: true }).fill('200');
    await editor.getByLabel('第1行单价', { exact: true }).fill('3.65');
    await expect(editor.getByLabel('第1行金额', { exact: true })).toHaveValue('730.00');
    await editor.getByLabel('主管', { exact: true }).fill('王主管');
    await editor.getByRole('button', { name: '应用到预览', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(frame().locator('tbody')).toContainText('编辑后的五层纸箱');
    await expect(frame().locator('.four-amount')).toContainText('1170.00');
    await expect(frame().locator('.four-signatures')).toContainText('王主管');
    await page.getByRole('button', { name: '编辑单据', exact: true }).click();
    await editor.getByLabel('单位', { exact: true }).fill('取消的修改');
    await editor.getByRole('button', { name: '取消编辑', exact: true }).click();
    await expect(frame().locator('.four-meta')).toContainText('本次打印客户');
    await page.getByRole('button', { name: '恢复原单内容', exact: true }).click();
    await expect(frame().locator('tbody')).toContainText('五层瓦楞纸箱');
    const formMargins = await frame().locator('.four-form').evaluate(element => {
      const paper = element.closest('.sheet').getBoundingClientRect(), box = element.getBoundingClientRect();
      return { left: box.left - paper.left, right: paper.right - box.right };
    });
    assert.ok(Math.abs(formMargins.left - formMargins.right) < 1, 'four-row form is centered on the physical sheet');
    await page.evaluate(() => { window.print = () => {}; });
    await page.getByRole('button', { name: '打印测试样张', exact: true }).click();
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('[data-dot-matrix-print-root] h1')).toHaveText('东光县曙光纸箱包装出库单');
    await expect(page.locator('[data-dot-matrix-print-root] tbody tr')).toHaveCount(4);
    if (name === 'chromium') {
      await page.locator('[data-dot-matrix-print-root] .sheet').screenshot({ path: path.join(artifacts, 'four-row-form.png') });
      await page.pdf({ path: path.join(artifacts, 'four-row-form.pdf'), preferCSSPageSize: true, printBackground: false });
    }
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page.getByRole('button', { name: '打印测试样张', exact: true })).toBeEnabled();
    await expect(frame().locator('tbody tr')).toHaveCount(4);
    await page.getByRole('button', { name: /预印出库单/ }).click();
    await expect(frame().locator('.preprinted-guide')).toHaveCount(1);
    await expect(frame().locator('table')).toHaveCount(0);
    await page.getByRole('button', { name: /空白连续纸/ }).click();
    await expect(page.getByRole('button', { name: /空白连续纸/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /241 × 140 mm/ }).click();
    await expect(frame().locator('h1').first()).toBeVisible();
    await page.getByRole('button', { name: '放大查看文字' }).click();
    const expanded = page.getByRole('dialog', { name: '放大查看测试样张' });
    await expect(expanded).toBeVisible();
    await expect(expanded.getByLabel('当前预览倍率')).toHaveText('100%');
    await expect(expanded.locator('iframe')).toHaveAttribute('title', '放大的针式单据预览');
    await expect(expanded.locator('iframe')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    if (name === 'chromium') await expanded.screenshot({ path: path.join(artifacts, 'preview-enlarged.png') });
    await expanded.getByRole('button', { name: '放大预览', exact: true }).click();
    await expect(expanded.getByLabel('当前预览倍率')).toHaveText('125%');
    await expanded.getByRole('button', { name: '关闭放大预览' }).click();
    await expect(expanded).toHaveCount(0);
    await expect(page.getByLabel('清晰无衬线字体')).toBeChecked();
    const initialType = await frame().locator('tbody td').first().evaluate(element => {
      const style = getComputedStyle(element); return { weight: Number(style.fontWeight), points: parseFloat(style.fontSize) * 72 / 96, family: style.fontFamily };
    });
    assert.equal(initialType.weight, 400, 'document body uses regular sans-serif text');
    assert.ok(initialType.points >= 9.9);
    assert.match(initialType.family, /Noto Sans|YaHei|微软雅黑/);
    const headingType = await frame().locator('h1').first().evaluate(element => {
      const style = getComputedStyle(element); return { weight: Number(style.fontWeight), family: style.fontFamily };
    });
    assert.ok(headingType.weight >= 600);
    assert.match(headingType.family, /YaHei|微软雅黑|SimHei|黑体/);
    await expect(frame().getByText('测试样张 · 不作为发货凭证', { exact: true })).toBeVisible();
    await expect(page.getByLabel('选择打印单据').locator('option')).toHaveCount(199); // sample + 197 receipts + one grouped outbound.
    await page.locator('iframe').evaluate(element => { window.__dotPrintCalls = 0; element.contentWindow.print = () => { throw new Error('The scaled preview must not be sent to the printer'); }; window.print = () => { window.__dotPrintCalls++; }; });
    await page.getByRole('button', { name: '打印测试样张', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__dotPrintCalls), 1);
    await expect(page.getByRole('status')).toContainText('实际出纸请以打印机为准');
    await expect(page.locator('[data-dot-matrix-print-root] tr[data-line]')).toHaveCount(2);
    await expect(page.locator('[data-dot-matrix-print-root]')).toBeHidden();
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page.locator('[data-dot-matrix-print-root]')).toHaveCount(0);

    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await expect(page.locator('[data-dot-matrix-print-root] tr[data-line]')).toHaveCount(2);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page.locator('[data-dot-matrix-print-root]')).toHaveCount(0);

    // The current preprinted outbound form uses the confirmed 241 x 140 mm stock.
    await page.getByLabel('选择打印单据').selectOption('12');
    await expect(printButton()).toBeEnabled();
    await expect(frame().locator('.sheet')).toHaveCount(3);
    await expect(frame().locator('tr[data-line]')).toHaveCount(12);
    await expect(frame().locator('img,script')).toHaveCount(0);
    await expect(frame().locator('h1').first()).toHaveText('东光县曙光纸箱包装');
    await expect(frame().locator('.footer').last()).toContainText('4200.00');
    await inspectPages();
    await savePdf('241x140', 241, 140, 3);
    await page.getByRole('button', { name: '返回', exact: true }).scrollIntoViewIfNeeded();
    await page.getByText('正在连接共享仓库，请稍候', { exact: true }).waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(artifacts, name + '-desktop.png'), fullPage: true });
    await page.locator('[class*="index-module__panel___"]').screenshot({ path: path.join(artifacts, name + '-print-panel.png') });

    await page.getByLabel('显示单价和金额').uncheck();
    await expect(printButton()).toBeEnabled();
    await expect(frame().getByRole('columnheader', { name: '单价', exact: true })).toHaveCount(0);
    await expect(frame().locator('body')).not.toContainText('4200.00');
    await page.getByLabel('显示单价和金额').check();
    await expect(printButton()).toBeEnabled();
    for (const [id, width, height] of [['241 × 93 mm', 241, 93], ['241 × 279 mm', 241, 279], ['210 × 297 mm', 210, 297]]) {
      await page.getByRole('button', { name: new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
      await expect(printButton()).toBeEnabled();
      const sheets = await inspectPages();
      assert.ok(Math.abs(sheets[0].width - width * 96 / 25.4) < 1);
      await savePdf(`${width}x${height}`, width, height, sheets.length);
    }
    await page.getByRole('button', { name: /自定义纸张尺寸/ }).click();
    await page.getByLabel('纸宽（mm）').fill('250');
    await page.getByLabel('纸高（mm）').fill('150');
    await page.getByLabel('打印抬头').focus();
    await expect(printButton()).toBeEnabled();
    const customSheets = await inspectPages();
    await savePdf('custom-250x150', 250, 150, customSheets.length);
    await page.getByRole('button', { name: /241 × 140 mm/ }).click();
    await page.getByRole('button', { name: /排版与位置校准/ }).click();
    await page.getByLabel('左右偏移（mm）').fill('2');
    await page.getByLabel('上下偏移（mm）').fill('-1');
    await page.getByLabel('打印抬头').fill('华兴纸箱厂');
    await expect(frame().locator('h1').first()).toHaveText('华兴纸箱厂');
    await page.getByLabel('每页最多明细').selectOption('3');
    await expect(printButton()).toBeEnabled();
    await expect(frame().locator('.sheet')).toHaveCount(4);
    const offsets = await frame().locator('.content').first().evaluate(element => ({ left: parseFloat(getComputedStyle(element).left), top: parseFloat(getComputedStyle(element).top) }));
    assert.ok(Math.abs(offsets.left - 32.5 * 96 / 25.4) < 1);
    assert.ok(Math.abs(offsets.top - 9 * 96 / 25.4) < 1);
    await page.reload();
    await expect(page.getByRole('button', { name: '打印测试样张', exact: true })).toBeEnabled();
    await expect(page.getByLabel('打印抬头')).toHaveValue('华兴纸箱厂');
    await page.getByRole('button', { name: /排版与位置校准/ }).click();
    await expect(page.getByLabel('左右偏移（mm）')).toHaveValue('2');
    await expect(page.getByLabel('上下偏移（mm）')).toHaveValue('-1');

    failRead = true;
    await page.getByLabel('选择打印单据').selectOption('12');
    await expect(page.getByRole('alert')).toContainText('测试：单据读取失败');
    await expect(page.getByRole('button', { name: '单据暂不可打印', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '重试读取单据', exact: true }).click();
    await expect(printButton()).toBeEnabled();
    voided = true;
    await page.getByRole('button', { name: '刷新单据', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('单据已作废');
    await expect(page.getByRole('button', { name: '单据暂不可打印', exact: true })).toBeDisabled();
    voided = false;
    await page.getByRole('button', { name: '刷新单据', exact: true }).click();
    await expect(printButton()).toBeEnabled();
    await page.getByLabel('选择打印单据').selectOption('');
    let releaseRead;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    holdRead = { promise: new Promise(resolve => { releaseRead = resolve; }), started: markStarted };
    await page.getByLabel('选择打印单据').selectOption('12');
    await started;
    await page.getByLabel('选择打印单据').selectOption('1000');
    await expect(printButton()).toBeEnabled();
    const completedRead = page.waitForResponse(response => response.url().includes('/api/transactions?type=out'));
    releaseRead();
    await completedRead;
    await expect(frame().locator('body')).toContainText('RK-1000');
    await expect(frame().locator('body')).not.toContainText('CK-20261003-001');

    await page.getByRole('button', { name: '流水报表', exact: true }).click();
    await expect(page.getByText('出入库流水（已加载 200 条）', { exact: true })).toBeVisible();
    await page.getByText('加载更多流水', { exact: true }).click();
    await expect(page.getByText('出入库流水（已加载 209 条）', { exact: true })).toBeVisible();
    await page.evaluate(() => { window.__ledgerPrintCalls = 0; window.print = () => { window.__ledgerPrintCalls++; }; });
    await page.getByRole('button', { name: '打印当前流水', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__ledgerPrintCalls), 1);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('button', { name: '打印当前流水', exact: true })).toBeHidden();
    await expect(page.locator('[class*="row___"]:visible')).toHaveCount(209);
    assert.equal(await page.locator('[class*="row___"]').first().evaluate(element => getComputedStyle(element).visibility), 'visible');
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    assert.equal(await page.locator('body').getAttribute('data-warehouse-print'), null);

    await page.goto(origin + '/index.html#/pages/print-center/index?transaction_id=12');
    await expect(printButton()).toBeEnabled();
    await expect(frame().locator('tr[data-line]')).toHaveCount(12);
    for (const width of [390, 320, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.locator('.taro_page:visible').last().evaluate(element => element.scrollWidth <= element.clientWidth + 1), `no page overflow at ${width}px`);
      if (width === 390) {
        await page.getByText('测试：单据读取失败', { exact: true }).waitFor({ state: 'hidden' });
        await page.screenshot({ path: path.join(artifacts, name + '-mobile.png'), fullPage: true });
        await page.getByRole('button', { name: /打印本单/ }).scrollIntoViewIfNeeded();
        await expect(printButton()).toBeVisible();
        await page.screenshot({ path: path.join(artifacts, name + '-mobile-preview.png') });
      }
      if (width === 320) await savePdf('narrow-screen-241x140', 241, 140, 4);
    }
    // The local bridge must use our visible printer controls, never the host's broken dropdown.
    await page.addInitScript(() => {
      window.__localRequests = [];
      window.__hostPrintCalls = 0;
      window.print = () => { window.__hostPrintCalls++; };
      window.__printerReadError = false;
      window.__printerWriteError = false;
      window.__localPrinters = [
        { name: 'EPSON LQ-630KII ESC/P2', displayName: 'EPSON LQ-630KII ESC/P2', isDefault: true, offline: false, unavailable: false, isPdf: false },
        { name: 'Deli A4 Printer', displayName: 'Deli A4 Printer', isDefault: false, offline: false, unavailable: false, isPdf: false },
        { name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF', isDefault: false, offline: false, unavailable: false, isPdf: true },
      ];
      window.warehouseLocalPrint = { version: 1,
        listPrinters: async () => {
          if (window.__printerReadError) throw new Error('测试：打印服务已断开');
          return window.__localPrinters.map(item => ({ ...item }));
        },
        print: async request => {
          window.__localRequests.push(request);
          if (window.__printerWriteError) throw Object.assign(new Error('测试：连接中断，请核对打印队列'), { safeToRetry: false });
          return new Promise(resolve => { window.__finishPrint = () => resolve({ printerName: request.printerName, kind: 'queued', pages: 4 }); });
        },
      };
    });
    await page.setViewportSize({ width: 1440, height: 1250 });
    await page.reload();
    await expect(printButton()).toBeEnabled();
    await expect(page.getByRole('radio', { name: /EPSON LQ/ })).toBeChecked();
    await page.getByRole('radio', { name: /Deli A4/ }).check();
    await expect(page.locator('[data-selected-printer]')).toContainText('Deli A4 Printer');
    await printButton().evaluate(element => { element.click(); element.click(); });
    await expect(page.getByRole('button', { name: '正在发送…', exact: true })).toBeDisabled();
    const firstJobs = await page.evaluate(() => window.__localRequests);
    assert.equal(firstJobs.length, 1, 'rapid repeat clicks submit only once');
    assert.equal(firstJobs[0].printerName, 'Deli A4 Printer', 'explicit selection is forwarded instead of the default EPSON');
    assert.equal(firstJobs[0].document.lines.length, 12);
    await page.evaluate(() => window.__finishPrint());
    await expect(page.getByRole('status')).toContainText('Deli A4 Printer');
    await page.reload();
    await expect(page.getByRole('radio', { name: /Deli A4/ })).toBeChecked();
    await expect(printButton()).toBeEnabled();
    await page.evaluate(() => { window.__localPrinters.find(item => item.name === 'Deli A4 Printer').offline = true; window.__localPrinters.find(item => item.name === 'Deli A4 Printer').unavailable = true; });
    await page.getByRole('button', { name: '刷新打印机', exact: true }).click();
    await expect(page.locator('[data-selected-printer]')).toContainText('当前不可用');
    await expect(printButton()).toBeDisabled();
    await expect(page.getByRole('radio', { name: /Deli A4/ })).toBeChecked();
    await page.evaluate(() => { window.__localPrinters = window.__localPrinters.filter(item => item.name !== 'Deli A4 Printer'); });
    await page.getByRole('button', { name: '刷新打印机', exact: true }).click();
    await expect(page.getByText('上次使用的打印机不可用，请重新选择。', { exact: true })).toBeVisible();
    await expect(printButton()).toBeDisabled();
    await page.getByRole('radio', { name: /Microsoft Print to PDF/ }).check();
    await expect(page.getByRole('button', { name: '保存本单 PDF', exact: true })).toBeEnabled();
    await page.getByRole('radio', { name: /EPSON LQ/ }).check();
    await page.evaluate(() => { window.__printerWriteError = true; });
    await printButton().click();
    await expect(page.getByRole('status')).toContainText('连接中断');
    await printButton().click();
    await expect(page.getByRole('status')).toContainText('连接中断');
    const retryJobs = await page.evaluate(() => window.__localRequests);
    assert.equal(retryJobs.length, 2);
    assert.equal(retryJobs[0].id, retryJobs[1].id, 'unknown network outcome reuses the original job id');
    assert.equal(retryJobs[0].printerName, 'EPSON LQ-630KII ESC/P2');
    await page.evaluate(() => { window.__printerReadError = true; });
    await page.getByRole('button', { name: '刷新打印机', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('打印服务已断开');
    await expect(printButton()).toBeDisabled();
    assert.equal(await page.evaluate(() => window.__hostPrintCalls), 0, 'bridge errors never fall back to the unusable host print dialog');
    await page.evaluate(() => { window.__printerReadError = false; });
    await page.getByRole('button', { name: '刷新打印机', exact: true }).click();
    await expect(printButton()).toBeEnabled();
    console.log(`${name}: printer selection, persistence, explicit device routing, duplicate prevention, missing/offline devices and connection failures passed`);

    extra = [{ ...outgoing[0], id: 9000, outbound_no: 'CK-LONG', remark: '超长明细内容'.repeat(1000) }];
    await page.goto(origin + '/index.html#/pages/print-center/index?transaction_id=9000');
    await expect(page.getByRole('alert')).toContainText('内容超出纸张');
    await expect(printButton()).toBeDisabled();
    await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }; });
    await page.goto(origin + '/index.html#/pages/print-center/index?transaction_id=12');
    await page.reload();
    await expect(frame().locator('tr[data-line]')).toHaveCount(12);
    await expect(printButton()).toBeDisabled();
    await expect(page.getByText('手机端可查看预览；请在连接针式打印机的电脑上打开同一张单据进行打印。', { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, [], 'preview and printing never mutate inventory or orders');
    console.log(`${name}: full documents, physical paper sizes, pagination, isolation, settings, price hiding, read failures, voided documents, read races and mobile layout passed`);
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, name + '-failure.png') });
    console.error('Preview errors:', await page.getByRole('alert').allTextContents());
    console.error('Page errors:', errors);
    throw error;
  } finally { await context.close(); }
}

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const app = express();
  app.use(express.static(root));
  app.get('*', (_, response) => response.sendFile(path.join(root, 'index.html')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
      if (process.env.PRINT_BROWSER && process.env.PRINT_BROWSER !== name) continue;
      const browser = await engine.launch();
      try { await verify(browser, origin, name); } finally { await browser.close(); }
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
