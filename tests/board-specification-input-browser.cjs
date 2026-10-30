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
  const commonCustomer = db.addCustomer({
    name: '常用纸板客户',
    specs: [{
      id: 'customer-board-common',
      goods: '客户常用纸板',
      specification: '150×100 cm',
      material: '客户牛卡',
      unit: '张',
      price: 2.2,
      unitPrice: 2.2,
      category: '纸板',
      kind: '纸板',
      boardLength: 150,
      boardWidth: 100,
      cartonLength: 42,
      cartonWidth: 32,
      cartonHeight: 22,
      fluteType: 'BC',
      layers: 5
    }]
  });
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

  let tearingDown = false;
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
        }).catch(issue => {
          // Context teardown may finish an in-flight read before route.fetch
          // returns. Ignore only that completed route during cleanup.
          if (!tearingDown || !/Route is already handled/.test(issue.message)) throw issue;
        });
      }
      if (/^https?:$/.test(url.protocol)) externalBlocked.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    });

    const fieldInput = label => page.getByLabel(label, { exact: true });
    const openDetails = async label => {
      const summary = page.locator('.demo-dialog summary').filter({ hasText: label });
      if (!await summary.evaluate(el => el.parentElement.open)) await summary.click();
    };
    const openBoardEntry = async (query = '', openSpecificationDetails = true) => {
      await page.goto('about:blank');
      await page.goto(`${origin}/#/pages/board-inbound/index${query}`);
      await expect(page.getByTestId('paperboard-receipt-sheet')).toBeVisible();
      if (openSpecificationDetails) {
        await openDetails('新增 / 修改规格');
        await openDetails('采购纸板尺寸 · 查看 / 调整');
      }
    };
    const length = fieldInput('实际纸板长'), width = fieldInput('实际纸板宽');
    const carton = fieldInput('纸箱尺寸：长 × 宽 × 高');
    await openBoardEntry('', false);
    await page.getByRole('button', { name: '点击选择常用规格', exact: true }).click();
    await page.getByRole('button', { name: /纸板 · 40\s*×\s*30\s*×\s*20 cm.*历史入库 · 历史模板板厂/ }).click();
    await expect(page.getByLabel('供货商', { exact: true })).toHaveValue(String(historicalSupplier.id));
    await openDetails('新增 / 修改规格');
    await openDetails('采购纸板尺寸 · 查看 / 调整');
    await expect(length).toHaveValue('160'); await expect(width).toHaveValue('110');
    await expect(carton).toHaveValue('40×30×20');
    assert.equal(db.listBoards().find(batch => batch.id === historyBoard.id).boardLength, 160);

    await openBoardEntry(`?id=${encodeURIComponent(decimalHistory.id)}`);
    await expect(length).toHaveValue('30.5'); await expect(width).toHaveValue('20.25');
    await expect(carton).toHaveValue('40.5×30.25×20.75');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByTestId('paperboard-detail-sheet')).toBeVisible();
    const savedDecimal = db.listBoards().find(row => row.id === decimalHistory.id);
    assert.deepEqual([savedDecimal.boardLength, savedDecimal.boardWidth, savedDecimal.cartonLength, savedDecimal.cartonWidth, savedDecimal.cartonHeight], [30.5, 20.25, 40.5, 30.25, 20.75]);
    assert.deepEqual([savedDecimal.customerName, savedDecimal.material, savedDecimal.printPlate, savedDecimal.printColor], ['历史客户', '历史材质', '历史版名', '蓝 / 黑']);
    assert.equal(db.getSupplier(historicalSupplier.id).payable, historyPayable, '编辑不得重复计入应付');

    const receiptSupplier = db.addSupplier({ name: '规格验收板厂' });
    await openBoardEntry();
    await fieldInput('供货商').selectOption(String(receiptSupplier.id));
    await openDetails('新增 / 修改规格');
    await openDetails('采购纸板尺寸 · 查看 / 调整');
    await length.fill('30'); await width.fill('20');
    await carton.fill(''); await carton.pressSequentially('302015');
    await expect(carton).toHaveValue('30×20×15');
    await carton.press('Backspace'); await expect(carton).toHaveValue('30×20×1');
    await carton.pressSequentially('5'); await expect(carton).toHaveValue('30×20×15');
    await fieldInput('材质 / 配纸（选填）').fill('牛卡 / 高强瓦楞');
    await fieldInput('实收数').fill('8'); await fieldInput('每平米单价').fill('2.4');
    await openDetails('更多信息');
    await fieldInput('客户').fill('青禾纸品');
    await fieldInput('计费平米').fill('50'); await fieldInput('订购数').fill('8');
    const baselineCount = db.listBoards().length, baselinePosts = boardPosts.length;
    const invalidSave = async () => {
      await page.getByRole('button', { name: '确认纸板入库', exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      assert.equal(boardPosts.length, baselinePosts); assert.equal(db.listBoards().length, baselineCount);
      assert.equal(db.getSupplier(receiptSupplier.id).payable, 0);
    };
    await width.fill(''); await invalidSave(); await width.fill('20');
    await carton.fill('30×20'); await invalidSave();
    await carton.fill('30×20×15×5'); await invalidSave();
    await carton.fill('30×20×15');
    const dateTime = await fieldInput('入库日期时间').inputValue();
    assert.match(dateTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    await expect(page.getByTestId('board-cost-preview')).toContainText('120.00');
    assert.deepEqual(db.listProducts().map(product => ({ id: product.id, stock: product.stock })), stockBefore);
    for (const phoneWidth of [320, 390]) {
      await page.setViewportSize({ width: phoneWidth, height: 844 });
      const overflowing = await page.locator('.demo-dialog').evaluate(el => el.scrollWidth > el.clientWidth + 1);
      assert.equal(overflowing, false);
      await page.screenshot({ path: path.join(evidence, `board-entry-${phoneWidth}.png`) });
    }
    await page.getByRole('button', { name: '确认纸板入库', exact: true }).click();
    await expect(page.getByTestId('paperboard-detail-sheet')).toBeVisible();
    const saved = db.listBoards().find(batch => batch.supplier_id === receiptSupplier.id);
    assert.ok(saved);
    assert.deepEqual([saved.boardLength, saved.boardWidth, saved.cartonLength, saved.cartonWidth, saved.cartonHeight], [30, 20, 30, 20, 15]);
    assert.equal(saved.date, dateTime.slice(0, 10)); assert.equal(saved.enteredAt, dateTime);
    assert.equal(saved.orderedQty, 8); assert.equal(saved.receivedQty, 8); assert.equal(saved.remainingQty, 8);
    assert.equal(saved.billedArea, 50); assert.equal(saved.unitPrice, 2.4); assert.equal(saved.amount, 120);
    assert.equal(db.getSupplier(receiptSupplier.id).payable, 120); assert.equal(db.getSupplier(historicalSupplier.id).payable, historyPayable);
    assert.deepEqual([saved.customerName, saved.material, saved.printPlate, saved.printColor], ['青禾纸品', '牛卡 / 高强瓦楞', '', '']);
    assert.deepEqual(db.listProducts().map(product => ({ id: product.id, stock: product.stock })), stockBefore);
    await page.getByText('批次操作', { exact: true }).click();
    await page.getByRole('button', { name: '编辑批次' }).click();
    await expect(page).toHaveURL(/pages\/board-inbound\/index\?id=/);
    await openDetails('新增 / 修改规格');
    await openDetails('采购纸板尺寸 · 查看 / 调整');
    await expect(length).toHaveValue('30'); await expect(width).toHaveValue('20');
    await page.reload(); await expect(fieldInput('供货商')).toHaveValue(String(receiptSupplier.id));
    await openDetails('新增 / 修改规格');
    await openDetails('采购纸板尺寸 · 查看 / 调整'); await openDetails('更多信息');
    await expect(length).toHaveValue('30'); await expect(width).toHaveValue('20');
    await expect(carton).toHaveValue('30×20×15'); await expect(fieldInput('客户')).toHaveValue('青禾纸品');
    await expect(fieldInput('计费平米')).toHaveValue('50'); await expect(fieldInput('每平米单价')).toHaveValue('2.4');
    await expect(fieldInput('入库日期时间')).toHaveValue(dateTime);
    // A history template carries its supplier and dimensions; only quantity is
    // entered before saving a new batch.
    await openBoardEntry('', false);
    await page.getByRole('button', { name: '点击选择常用规格', exact: true }).click();
    await page.getByRole('button', { name: /纸板 · 40\s*×\s*30\s*×\s*20 cm.*历史入库 · 历史模板板厂/ }).click();
    await expect(page.getByLabel('供货商', { exact: true })).toHaveValue(String(historicalSupplier.id));
    await page.getByLabel('实收数', { exact: true }).fill('2');
    await page.getByRole('button', { name: '确认纸板入库', exact: true }).click();
    await expect(page.getByTestId('paperboard-detail-sheet')).toBeVisible();
    const savedFromHistory = db.listBoards()[0];
    assert.equal(savedFromHistory.receivedQty, 2);
    assert.equal(savedFromHistory.supplier_id, historicalSupplier.id);
    assert.deepEqual([savedFromHistory.boardLength, savedFromHistory.boardWidth, savedFromHistory.cartonLength, savedFromHistory.cartonWidth, savedFromHistory.cartonHeight], [160, 110, 40, 30, 20]);

    // A customer common specification also carries both board and carton
    // dimensions from the customer profile; selecting a supplier and quantity
    // is sufficient to create a payable purchase receipt.
    await openBoardEntry('', false);
    await page.getByLabel('供货商', { exact: true }).selectOption(String(receiptSupplier.id));
    await page.getByRole('button', { name: '点击选择常用规格', exact: true }).click();
    await page.getByRole('button', { name: /客户常用纸板 · 42\s*×\s*32\s*×\s*22 cm/ }).click();
    await expect(page.getByLabel('实际纸板长', { exact: true })).toHaveValue('150');
    await expect(page.getByLabel('纸箱尺寸：长 × 宽 × 高', { exact: true })).toHaveValue('42×32×22');
    await page.getByLabel('实收数', { exact: true }).fill('3');
    await page.getByRole('button', { name: '确认纸板入库', exact: true }).click();
    await expect(page.getByTestId('paperboard-detail-sheet')).toBeVisible();
    const savedFromCustomer = db.listBoards()[0];
    assert.equal(savedFromCustomer.receivedQty, 3);
    assert.equal(savedFromCustomer.supplier_id, receiptSupplier.id);
    assert.deepEqual([savedFromCustomer.boardLength, savedFromCustomer.boardWidth, savedFromCustomer.cartonLength, savedFromCustomer.cartonWidth, savedFromCustomer.cartonHeight], [150, 100, 42, 32, 22]);
    assert.equal(savedFromCustomer.unitPrice, 2.2);
    assert.equal(db.getSupplier(receiptSupplier.id).payable, 129.9);
    assert.deepEqual(pageErrors, []); assert.deepEqual(externalBlocked, []);
    console.log('PASS new board entry: separate dimensions, decimal history, invalid input, native keyboard formatting, metadata/edit reload, supplier accounting, 320/390px.');
  } finally {
    tearingDown = true;
    await context.unrouteAll({ behavior: 'wait' });
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
