const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function main() {
  const evidence = path.resolve(process.env.BOARD_SPEC_EVIDENCE_DIR || path.join(root, 'release/board-specification-input/evidence'));
  const webRoot = path.resolve(process.env.BOARD_SPEC_WEB_DIR || process.env.TARO_OUTPUT_DIR || path.join(root, 'dist'));
  if (!fs.existsSync(path.join(webRoot, 'index.html'))) throw new Error(`H5 构建目录缺少 index.html: ${webRoot}`);
  fs.mkdirSync(evidence, { recursive: true });

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-board-spec-browser-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], ledger: []
  }));

  const db = require(path.join(root, 'backend/db'));
  const app = express();
  app.use(express.json({ limit: '18mb' }));
  app.use('/api', require(path.join(root, 'backend/team'))(db));
  app.use(express.static(webRoot));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {});
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'zh-CN' });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const pageErrors = [];
  const externalBlocked = [];
  const boardPosts = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/boards' && request.method() === 'POST') boardPosts.push(request);
  });

  const historicalSupplier = db.addSupplier({ name: '历史模板板厂' });
  const historyDate = '2026-10-01';
  const sharedHistory = {
    supplier: historicalSupplier.name, supplier_id: historicalSupplier.id,
    fluteType: 'B',
    layers: 3,
    orderedQty: 25,
    receivedQty: 25,
    billedArea: 176,
    unitPrice: 1,
    date: historyDate
  };
  const historyBoard = db.receiveBoard({
    ...sharedHistory,
    boardLength: 160,
    boardWidth: 110,
    cartonLength: 40,
    cartonWidth: 30,
    cartonHeight: 20,
    deliveryNo: 'HISTORY-BOARD-160-110'
  });
  const decimalHistory = db.receiveBoard({
    ...sharedHistory,
    customerName: '历史客户',
    material: '历史材质',
    printPlate: '历史版名',
    printColor: '蓝 / 黑',
    boardLength: 30.5,
    boardWidth: 20.25,
    cartonLength: 40.5,
    cartonWidth: 30.25,
    cartonHeight: 20.75,
    deliveryNo: 'HISTORY-DECIMAL-SIZES'
  });
  const historyPayable = db.getSupplier(historicalSupplier.id).payable;
  const stockBefore = db.listProducts().map(product => ({ id: product.id, stock: product.stock }));

  const externalApiPath = pathname => pathname.startsWith('/api/');
  const corsHeaders = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'Authorization,Content-Type,If-Match,Idempotency-Key,X-Warehouse-Device',
    'access-control-expose-headers': 'X-Warehouse-Revision'
  };

  try {
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (/^https?:$/.test(url.protocol) && externalApiPath(url.pathname)) {
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: corsHeaders });
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({
          response,
          headers: { ...response.headers(), ...corsHeaders }
        });
      }
      if (/^https?:$/.test(url.protocol)) externalBlocked.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    });

    const fieldInput = label => page.locator(
      `taro-input-core[aria-label=${JSON.stringify(label)}] input, [aria-label=${JSON.stringify(label)}] input, input[aria-label=${JSON.stringify(label)}]`,
    ).first();
    const buttonByText = label => page.getByText(label, { exact: true }).last()
      .locator('xpath=ancestor-or-self::*[self::taro-button-core or self::button][1]');
    const buttonContainingText = label => page.locator('taro-button-core, button').filter({ hasText: label }).last();
    const openBoardEntry = async query => {
      await page.goto(`${origin}/#/pages/management/index?section=paperboard-receipt${query?.replace(/^\?/, '&') || ''}`);
      await expect(page.locator('.team-boot')).toBeHidden();
      await expect(page.locator('[aria-label="纸板规格尺寸"]')).toBeVisible();
      await expect(page.locator('[aria-label="成箱规格尺寸"]')).toBeVisible();
    };
    const boardSpec = fieldInput('纸板规格尺寸');
    const cartonSpec = fieldInput('成箱规格尺寸');
    const saveButton = () => buttonByText('确认入库 · 生成批次标签');
    const assertNoOverflow = async width => {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(() => {
        const rootNode = document.querySelector('.stock-entry-page') || document.body;
        const inputOverflow = [...document.querySelectorAll('input, textarea')]
          .filter(input => input.getClientRects().length > 0 && getComputedStyle(input).visibility !== 'hidden')
          .some(input => {
          const bounds = input.getBoundingClientRect();
          return bounds.left < -1 || bounds.right > innerWidth + 1;
        });
        return document.documentElement.scrollWidth <= innerWidth + 1
          && document.body.scrollWidth <= innerWidth + 1
          && rootNode.scrollWidth <= rootNode.clientWidth + 1
          && !inputOverflow;
      }), { message: `纸板入库表单在 ${width}px 不应横向溢出` }).toBe(true);
      await page.locator('.stock-entry-header').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(evidence, `board-entry-${width}.png`), fullPage: true });
    };

    await openBoardEntry();
    await buttonContainingText('选择已有规格').click();
    await expect(page.getByText('历史入库规格', { exact: true })).toBeVisible();
    await buttonByText('160 × 110 cm · B楞 · 历史模板板厂').click();
    await expect(boardSpec).toHaveValue('160×110');
    await expect(cartonSpec).toHaveValue('40×30×20');
    assert.equal(db.listBoards().find(batch => batch.id === historyBoard.id).boardLength, 160);

    await openBoardEntry(`?id=${encodeURIComponent(decimalHistory.id)}`);
    await expect(boardSpec).toHaveValue('30.5×20.25');
    await expect(cartonSpec).toHaveValue('40.5×30.25×20.75');
    await buttonByText('保存修改').click();
    await expect(page.getByText(`历史模板板厂 · ${historyDate} 到货`, { exact: true })).toBeVisible();
    const savedDecimal = db.listBoards().find(batch => batch.id === decimalHistory.id);
    assert.deepEqual(
      [savedDecimal.boardLength, savedDecimal.boardWidth, savedDecimal.cartonLength, savedDecimal.cartonWidth, savedDecimal.cartonHeight],
      [30.5, 20.25, 40.5, 30.25, 20.75],
      '编辑保存必须保留历史批次纸板和成箱规格中的小数尺寸'
    );
    assert.deepEqual(
      [savedDecimal.customerName, savedDecimal.material, savedDecimal.printPlate, savedDecimal.printColor],
      ['历史客户', '历史材质', '历史版名', '蓝 / 黑'],
      '编辑历史批次时仍保留已隐藏的印刷资料'
    );
    assert.equal(db.getSupplier(historicalSupplier.id).payable, historyPayable, '历史批次编辑不能重复计入货款');

    // Start a clean form after checking the history template, then exercise
    // actual keyboard input so the auto-inserted separator behavior is covered.
    await openBoardEntry();
    const receiptSupplier = db.addSupplier({ name: '演示纸板入库板厂' });
    await page.locator('.stock-entry-refresh').click();
    await page.getByTestId('supplier-search-open').click();
    await page.getByTestId(`supplier-search-result-${receiptSupplier.id}`).click();
    await fieldInput('客户').fill('青禾纸品');
    await fieldInput('材质 / 配纸').fill('牛卡 / 120g高强瓦楞 / 140g芯纸');
    await expect(fieldInput('印刷版名')).toHaveCount(0);
    await expect(fieldInput('颜色')).toHaveCount(0);
    await fieldInput('实收数').fill('8');
    await fieldInput('计费平米').fill('50');
    await fieldInput('每平米单价').fill('2.4');
    await buttonContainingText('更多信息').click();
    await fieldInput('订购数').fill('8');

    await boardSpec.fill('');
    await expect(boardSpec).toHaveValue('');
    await boardSpec.type('30');
    await expect(boardSpec).toHaveValue('30×');
    await boardSpec.pressSequentially('20');
    await expect(boardSpec).toHaveValue('30×20');
    await boardSpec.press('Backspace');
    await expect(boardSpec).toHaveValue('30×2');
    await boardSpec.pressSequentially('0');
    await expect(boardSpec).toHaveValue('30×20');

    await cartonSpec.fill('');
    await cartonSpec.type('30');
    await expect(cartonSpec).toHaveValue('30×');
    await cartonSpec.pressSequentially('2015');
    await expect(cartonSpec).toHaveValue('30×20×15');
    await cartonSpec.press('Backspace');
    await expect(cartonSpec).toHaveValue('30×20×1');
    await cartonSpec.pressSequentially('5');
    await expect(cartonSpec).toHaveValue('30×20×15');
    await expect(page.locator('.board-detail-row').filter({ hasText: '本批货款' })).toContainText('¥ 120.00');

    const boardCountBeforeInvalid = db.listBoards().length;
    const postsBeforeInvalid = boardPosts.length;
    const tryInvalidSave = async () => {
      const save = saveButton();
      if (await save.isEnabled()) await save.click();
      await expect(boardSpec).toBeVisible();
      await expect(cartonSpec).toBeVisible();
      await page.waitForTimeout(150);
      assert.equal(boardPosts.length, postsBeforeInvalid, '规格不完整或维度过多时不得发起纸板入库提交');
      assert.equal(db.listBoards().length, boardCountBeforeInvalid, '无效规格不得生成批次或增加库存');
      assert.equal(db.getSupplier(historicalSupplier.id).payable, historyPayable, '无效规格不得改变货款');
    };

    await boardSpec.fill('');
    await expect(boardSpec).toHaveValue('');
    await boardSpec.type('30');
    await expect(boardSpec).toHaveValue('30×');
    await tryInvalidSave();
    await boardSpec.fill('30×20×10');
    await expect(boardSpec).toHaveValue('30×20×10');
    await tryInvalidSave();
    await boardSpec.fill('30×20');
    await cartonSpec.fill('30×20');
    await expect(cartonSpec).toHaveValue('30×20');
    await tryInvalidSave();
    await cartonSpec.fill('30×20×15×5');
    await expect(cartonSpec).toHaveValue('30×20×15×5');
    await tryInvalidSave();

    await boardSpec.fill('30×20');
    await cartonSpec.fill('30×20×15');
    const displayedDate = await page.locator('.board-simple-entry .stock-entry-field')
      .filter({ hasText: '业务日期' }).innerText();
    const dateMatch = displayedDate.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
    assert.ok(dateMatch, `业务日期应显示 ISO 日期，实际字段：${displayedDate}`);
    const date = dateMatch[0];
    const amountBefore = 50 * 2.4;
    assert.equal(db.getSupplier(historicalSupplier.id).payable, historyPayable, '填写规格、数量和计费信息时不应提前记货款');
    assert.equal(db.listBoards().length, boardCountBeforeInvalid, '填写但未提交时库存批次数不变');
    assert.deepEqual(db.listProducts().map(product => ({ id: product.id, stock: product.stock })), stockBefore, '纸板尺寸录入不能改动成品库存');

    await assertNoOverflow(320);
    await assertNoOverflow(390);
    await page.setViewportSize({ width: 390, height: 900 });
    await saveButton().click();
    await expect(page.getByText('已入库。批次编号', { exact: false })).toBeVisible();

    const saved = db.listBoards().find(batch => batch.supplier === '演示纸板入库板厂');
    assert.ok(saved, '确认入库后后端应保存新纸板批次');
    assert.deepEqual(
      [saved.customerName, saved.material, saved.printPlate, saved.printColor],
      ['青禾纸品', '牛卡 / 120g高强瓦楞 / 140g芯纸', '', ''],
      '新批次保存客户和材质，印刷版名与颜色留到打印时填写'
    );
    assert.deepEqual(
      [saved.boardLength, saved.boardWidth, saved.cartonLength, saved.cartonWidth, saved.cartonHeight],
      [30, 20, 30, 20, 15],
      'API 应收到实际解析出的2维纸板尺寸和3维纸箱尺寸'
    );
    assert.equal(saved.date, date, '保存日期应与表单显示日期一致');
    assert.equal(saved.orderedQty, 8);
    assert.equal(saved.receivedQty, 8);
    assert.equal(saved.remainingQty, 8);
    assert.equal(saved.billedArea, 50);
    assert.equal(saved.unitPrice, 2.4);
    assert.equal(saved.amount, amountBefore, '本批货款继续按计费平米 × 单价计算，而非规格或实收数');
    assert.equal(db.getSupplier(saved.supplier_id).name, '演示纸板入库板厂');
    assert.equal(db.getSupplier(saved.supplier_id).payable, amountBefore, '供应商应付只增加本单货款');
    assert.equal(db.getSupplier(historicalSupplier.id).payable, historyPayable);
    assert.deepEqual(db.listProducts().map(product => ({ id: product.id, stock: product.stock })), stockBefore);

    await expect(page.getByText(`演示纸板入库板厂 · ${date} 到货`, { exact: true })).toBeVisible();
    await expect(page.getByText('8 / 8 张', { exact: true })).toBeVisible();
    await expect(page.getByText('¥ 120.00', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'saved-board-batch.png'), fullPage: true });

    await openBoardEntry(`?id=${encodeURIComponent(saved.id)}`);
    await expect(boardSpec).toHaveValue('30×20');
    await expect(cartonSpec).toHaveValue('30×20×15');
    await expect(page.getByTestId('supplier-search-open')).toContainText('演示纸板入库板厂');
    await expect(fieldInput('客户')).toHaveValue('青禾纸品');
    await expect(fieldInput('材质 / 配纸')).toHaveValue('牛卡 / 120g高强瓦楞 / 140g芯纸');
    await expect(fieldInput('印刷版名')).toHaveCount(0);
    await expect(fieldInput('颜色')).toHaveCount(0);
    await expect(fieldInput('实收数')).toHaveValue('8');
    await page.reload();
    await expect(page.locator('.team-boot')).toBeHidden();
    await expect(boardSpec).toHaveValue('30×20');
    await expect(cartonSpec).toHaveValue('30×20×15');
    await expect(page.getByTestId('supplier-search-open')).toContainText('演示纸板入库板厂');
    await expect(fieldInput('客户')).toHaveValue('青禾纸品');
    await expect(fieldInput('材质 / 配纸')).toHaveValue('牛卡 / 120g高强瓦楞 / 140g芯纸');
    await expect(fieldInput('印刷版名')).toHaveCount(0);
    await expect(fieldInput('颜色')).toHaveCount(0);
    await expect(fieldInput('实收数')).toHaveValue('8');
    await expect(fieldInput('计费平米')).toHaveValue('50');
    await expect(fieldInput('每平米单价')).toHaveValue('2.4');
    assert.deepEqual(pageErrors, [], '浏览器页面不应产生运行时异常');
    assert.ok(externalBlocked.every(request => !request.includes('youxishen.online')), '被拦截的外部网络请求不得到达生产域名');
    console.log(`PASS: two-/three-dimension string input, keyboard separator/deletion, invalid dimensions, historical templates and metadata, persisted edit reload, amount/supplier/quantity/date, print-only plate/color entry, isolated local API, 320/390px layouts. Evidence: ${evidence}`);
  } finally {
    await context.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(temporary).startsWith(tempRoot), 'temporary database must remain inside the OS temp directory');
    fs.rmSync(temporary, { recursive: true, force: true });
    delete require.cache[require.resolve(path.join(root, 'backend/db'))];
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
