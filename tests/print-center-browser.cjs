const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');
const QRCode = require('qrcode');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-delivery-browser-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.PRINT_WEB_DIR || 'release/print-center-01a1211e/web');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('../backend/db');

  process.env.WAREHOUSE_REMOTE_PRINT_FILE = path.join(directory,'remote-print.json');
  const app = process.env.PRINT_SOURCE_PREVIEW === '1' ? require('./helpers/print-center-source.cjs')(db) : require('../backend/server');
  const pair = require('../backend/remote-print').createStore(process.env.WAREHOUSE_REMOTE_PRINT_FILE).register('店里电脑','EPSON LQ-630K ESC/P2');
  require('../backend/remote-print').createStore(process.env.WAREHOUSE_REMOTE_PRINT_FILE).claim(pair.agent,true);
  const customer = db.addCustomer({ name: '华兴包装（演示）', contact: '王先生', phone: '13800000000', address: '河北省沧州市东光县工业园', specs: [{ id: 'spec-demo', goods: '五层瓦楞纸箱', specification: '30x20*15mm', material: '五层', unit: '箱', price: 3.5 }] });
  db.updateCustomer(customer.id, { specs: [{ id: 'spec-demo', goods: '五层瓦楞纸箱', specification: '30x20*15mm', unit: '个', price: 3.5 }] });
  const product = db.addProduct({ name: '五层瓦楞纸箱', specification: '30×20×15', unit: '个', stock: 1000, price: 3.5 });
  db.addCustomer({ name: '宏远纸业（演示）', contact: '李女士', phone: '13900000000', address: '东光县开发区' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const engine = process.env.PRINT_BROWSER || 'chromium';
  const browser = await (engine === 'webkit' ? webkit : chromium).launch(engine === 'webkit' || !process.env.PRINT_BROWSER_EXECUTABLE ? {} : { executablePath: process.env.PRINT_BROWSER_EXECUTABLE });
  const artifacts = path.resolve(process.env.PRINT_ARTIFACTS || 'release/print-center-01a1211e/check', engine);
  fs.mkdirSync(artifacts, { recursive: true });
  const errors = [];
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'zh-CN' });
    let failSave = false, failHistory = false, holdCustomer = false, releaseCustomer;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin || !/^https?:$/.test(url.protocol)) return route.continue();
      if (!url.pathname.startsWith('/api/')) return route.abort();
      if (failSave && url.pathname.startsWith('/api/print-notes') && request.method() !== 'GET') {
        failSave = false; return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试保存失败，内容已保留' }) });
      }
      if (failHistory && url.pathname === '/api/print-notes' && request.method() === 'GET') {
        failHistory = false; return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试历史加载失败' }) });
      }
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      if (holdCustomer && url.pathname === '/api/customers' && url.searchParams.get('keyword') === '华兴') {
        holdCustomer = false; await new Promise(resolve => { releaseCustomer = resolve; });
      }
      return route.fulfill({ response });
    });
    page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    const active = () => page.locator('.taro_page:visible').last();
    const button = name => page.getByRole('button', { name, exact: true });
    const noOverflow = async () => {
      await expect.poll(() => page.locator('main').first().evaluate(element => element.scrollWidth <= element.clientWidth + 1), { message: 'mobile page must not overflow horizontally' }).toBe(true);
      assert.equal(await active().locator('input:visible,select:visible').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().right > innerWidth + 1 || element.getBoundingClientRect().left < -1).length), 0, 'fields fit viewport');
    };
    const actionLayout = () => page.locator('main').first().evaluate(element => {
      const bar = element.querySelector('footer'), rect = bar.getBoundingClientRect();
      const form = element.querySelector('fieldset'), formRect = form && form.getBoundingClientRect();
      return { position: getComputedStyle(bar).position, top: rect.top, bottom: rect.bottom, scrollTop: element.scrollTop, formBottom: formRect && formRect.bottom, viewportBottom: element.getBoundingClientRect().bottom, paddingBottom: parseFloat(getComputedStyle(element).paddingBottom), scrollPaddingBottom: parseFloat(getComputedStyle(element).scrollPaddingBottom) };
    });
    const actionsFollowForm = async () => {
      const layout = await actionLayout();
      assert.equal(layout.position, 'static', 'actions remain in document flow rather than covering input fields');
      assert.ok(layout.top >= layout.formBottom, 'actions follow all form fields: ' + JSON.stringify(layout));
      assert.ok(layout.paddingBottom >= 102, 'page reserves dock space after the actions');
      assert.ok(layout.scrollPaddingBottom >= layout.paddingBottom, 'focused fields scroll into the unobstructed viewport above the dock');
    };
    await page.goto(origin + '/#/pages/print-center/index');
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await page.goto(origin + '/#/pages/print-center/index?mode=edit');
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '新建送货单', exact: true }).click();
    await button('搜索客户').click();
    await page.getByLabel('搜索客户名称或电话').fill('13800000000');
    await page.getByRole('button', { name: /华兴包装（演示）/ }).click();
    await expect(page.getByLabel('收货单位', { exact: true })).toHaveValue(customer.name);
    await expect(page.getByLabel('收货地址', { exact: true })).toHaveValue(customer.address);
    await expect(page.getByLabel('收货人', { exact: true })).toHaveValue(customer.contact);
    await page.getByLabel('选择客户常用规格').selectOption('spec-demo');
    await expect(page.getByLabel('第1项规格尺寸')).toHaveValue('30×20×15');
    await page.getByLabel('第1项规格尺寸').fill('30x20*15');
    await expect(page.getByLabel('第1项规格尺寸')).toHaveValue('30×20×15');
    await expect(page.getByLabel('第1项规格尺寸')).toBeFocused();
    await page.getByLabel('第1项规格尺寸').fill('');
    await page.getByLabel('第1项规格尺寸').pressSequentially('30');
    await expect(page.getByLabel('第1项规格尺寸')).toHaveValue('30×');
    await page.getByLabel('第1项规格尺寸').pressSequentially('20');
    await expect(page.getByLabel('第1项规格尺寸')).toHaveValue('30×20×');
    await page.getByLabel('第1项规格尺寸').pressSequentially('15');
    await expect(page.getByLabel('第1项规格尺寸')).toHaveValue('30×20×15');
    await page.getByLabel('第1项规格尺寸').press('Backspace');
    await expect(page.getByLabel('第1项规格尺寸')).toHaveValue('30×20×1');
    await page.getByLabel('第1项规格尺寸').pressSequentially('5');
    await expect(button('两位数')).toHaveCount(0);
    await expect(button('三位数')).toHaveCount(0);
    await page.getByLabel('第1项数量').fill('100');
    await page.getByLabel('送货人', { exact: true }).fill('张师傅');
    await page.getByLabel('第1项备注').fill('请轻拿轻放');
    await noOverflow();
    const dateInput=page.getByLabel('送货日期',{exact:true});
    assert.equal(await dateInput.evaluate(element=>getComputedStyle(element).opacity),'0','native date chrome is hidden in the compiled app');
    assert.equal(await dateInput.evaluate(element=>getComputedStyle(element).position),'absolute','native date editor cannot contribute intrinsic grid width');
    await dateInput.fill('2026-10-12');
    await expect(dateInput.locator('..')).toContainText('2026/10/12');
    await dateInput.fill('2026-10-11');
    const dateBounds=await dateInput.evaluate(input=>{const r=input.parentElement.getBoundingClientRect(),p=input.parentElement.parentElement.getBoundingClientRect();return {right:r.right,parentRight:p.right,height:r.height};});
    assert.ok(dateBounds.right<=dateBounds.parentRight+1,'localized date stays inside its column');
    assert.equal(dateBounds.height,46,'date matches the other input heights');
    await dateInput.evaluate(input=>{input.style.minWidth='300px';input.style.minHeight='70px';});
    // Hit testing is meaningful only while this row is inside the safe viewport.
    // WebKit can retain the scroll offset from the later remark field after fill().
    await page.getByLabel('送货人',{exact:true}).evaluate(input=>input.scrollIntoView({block:'center',behavior:'instant'}));
    const dateClipping=await dateInput.evaluate(input=>{const wrapper=input.parentElement,r=wrapper.getBoundingClientRect(),sender=document.querySelector('input[aria-label="送货人"]'),s=sender.getBoundingClientRect();return {height:r.height,clips:getComputedStyle(wrapper).overflow,right:r.right,senderLeft:s.left,hit:document.elementFromPoint(s.left+s.width/2,s.top+s.height/2)===sender};});
    assert.equal(dateClipping.height,46);assert.equal(dateClipping.clips,'hidden');assert.ok(dateClipping.right<dateClipping.senderLeft);assert.ok(dateClipping.hit,'oversized iOS picker cannot cover sender');
    await dateInput.evaluate(input=>{input.style.removeProperty('min-width');input.style.removeProperty('min-height');});
    const main=page.locator('main').first();
    await main.evaluate(element=>element.style.setProperty('--print-safe-top','59px'));
    await page.getByLabel('送货日期',{exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(artifacts,'mobile-date-safe-area.png')});
    await main.evaluate(element=>{element.scrollTop=360;});
    assert.equal(await main.evaluate(element=>element.getBoundingClientRect().top),59,'scroll viewport starts below the status bar');
    await actionsFollowForm();
    const scrollLayout = await actionLayout();
    await main.evaluate(element=>{element.scrollTop += 100;});
    const movedLayout = await actionLayout();
    assert.ok(movedLayout.scrollTop > scrollLayout.scrollTop, 'long form scrolls normally');
    assert.ok(Math.abs((scrollLayout.top - movedLayout.top) - (movedLayout.scrollTop - scrollLayout.scrollTop)) < 2, 'actions scroll with the form instead of floating over it');
    await main.evaluate(element=>{element.scrollTop=element.scrollHeight;});
    const endLayout = await actionLayout();
    assert.ok(endLayout.bottom <= endLayout.viewportBottom - endLayout.paddingBottom + 1, 'actions are fully accessible above the bottom dock: ' + JSON.stringify(endLayout));
    await page.screenshot({path:path.join(artifacts,'mobile-scroll-actions.png')});
    await main.evaluate(element=>{element.style.removeProperty('--print-safe-top');element.scrollTop=0;});
    await page.screenshot({ path: path.join(artifacts, 'mobile-editor.png'), fullPage: true });
    await button('保存单据').click();
    await expect.poll(() => db.listPrintNotes().length).toBe(1);
    await expect(button('已保存')).toBeDisabled();
    let saved = db.listPrintNotes()[0]; assert.equal(saved.total, 350);
    assert.equal(saved.items[0].name, product.name);
    await button('历史单据').click();
    await expect(page.getByLabel('搜索历史单据')).toBeVisible();
    await page.getByLabel('搜索历史单据').fill('华兴');
    await page.getByRole('button', { name: /查看详情/ }).click();
    await expect(page.getByRole('heading', { name: '单据详情' })).toBeVisible();
    await noOverflow();
    await page.screenshot({ path: path.join(artifacts, 'mobile-detail.png'), fullPage: true });
    await button('编辑单据').click();
    await page.getByLabel('第1项数量').fill('120');
    await button('保存单据').click();
    await expect.poll(() => db.listPrintNotes()[0].total).toBe(420);
    assert.equal(db.listPrintNotes().length, 1); assert.equal(db.listPrintNotes()[0].number, saved.number);
    await page.goto(origin + '/#/pages/print-center/index?mode=edit');
    await page.goto(origin + '/#/pages/print-center/index?mode=edit');
    await page.reload();
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await button('历史单据').click(); await page.getByRole('button', { name: /查看详情/ }).click();
    await expect(page.getByText('30×20×15 · 120 个 × ¥ 3.5')).toBeVisible();
    await button('编辑单据').click(); await page.getByLabel('第1项备注').fill('保存失败也保留');
    failSave = true; await button('保存单据').click();
    await expect(page.getByRole('alert')).toHaveText('测试保存失败，内容已保留');
    await expect(page.getByLabel('第1项备注')).toHaveValue('保存失败也保留');
    await button('保存单据').click(); await expect(button('已保存')).toBeDisabled();
    await button('搜索客户').click(); holdCustomer = true;
    await page.getByLabel('搜索客户名称或电话').fill('华兴');
    await expect.poll(() => typeof releaseCustomer).toBe('function');
    await page.getByLabel('搜索客户名称或电话').fill('宏远');
    await page.getByRole('button', { name: /宏远纸业/ }).waitFor(); releaseCustomer();
    await expect(page.getByRole('button', { name: /华兴包装（演示）/ })).toHaveCount(0);
    await button('关闭').click();
    await page.getByLabel('第1项数量').fill('125');
    await button('＋ 新建').click(); await expect(page.getByRole('dialog', { name: '保留未保存内容' })).toBeVisible();
    await button('继续编辑').click(); await expect(page.getByLabel('第1项数量')).toHaveValue('125');
    await page.getByLabel('第1项数量').fill('120');
    await button('确认出库并打印').click();
    await expect.poll(() => db.listPrintNotes()[0].outbound_at).toBeTruthy();
    assert.equal(db.getProduct(product.id).stock, 880);
    assert.equal(db.getCustomer(customer.id).debt, 420);
    await expect.poll(() => db.listTx().filter(row => row.type === 'out').length).toBe(1);
    await expect(button('打印送货单')).toBeEnabled();
    const frame = () => page.frameLocator('iframe[title="送货单纸张预览"]');
    await expect(frame().getByRole('heading', { name: '送 货 单' })).toBeVisible();
    await expect(frame().getByText('30×20×15')).toBeVisible();
    await expect(frame().locator('tr[data-line] td:nth-child(2)')).toHaveText(product.name);
    const remoteStore=require('../backend/remote-print').createStore(process.env.WAREHOUSE_REMOTE_PRINT_FILE);
    remoteStore.claim(pair.agent,true);
    await page.getByText(/远程打印到店里/).click();
    await expect(page.getByLabel('打印电脑配对码')).toHaveCount(0);
    const fileChooserPromise = page.waitForEvent('filechooser');
    await button('扫描连接二维码').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'print-pair.png',
      mimeType: 'image/png',
      buffer: await QRCode.toBuffer(pair.client, { width: 360, margin: 2 })
    });
    await button('发送到630K').click();
    await expect(page.getByRole('dialog', { name: '送货单预览' }).getByRole('status')).toContainText('等待打印电脑接收');
    const remoteClaim=remoteStore.claim(pair.agent,true).job;
    assert.equal(remoteClaim.note.items[0].name,product.name);
    remoteStore.acknowledge(pair.agent,remoteClaim.id,{lease:remoteClaim.lease,status:'queued'});
    await expect(page.getByRole('dialog', { name: '送货单预览' }).getByRole('status')).toContainText('已送入630K打印队列');
    await button('再打印一份').click();
    await expect(page.getByRole('group',{name:'确认重新打印'})).toBeVisible();
    assert.equal(JSON.parse(fs.readFileSync(process.env.WAREHOUSE_REMOTE_PRINT_FILE)).jobs.length,1,'reprint requires explicit confirmation');
    await button('确认再打印一份').click();
    await expect(page.getByRole('dialog', { name: '送货单预览' }).getByRole('status')).toContainText('等待打印电脑接收');
    const reprint=remoteStore.claim(pair.agent,true).job;
    assert.notEqual(reprint.id,remoteClaim.id,'confirmed reprint gets a new job');
    remoteStore.acknowledge(pair.agent,reprint.id,{lease:reprint.lease,status:'queued'});
    await expect(page.getByRole('dialog', { name: '送货单预览' }).getByRole('status')).toContainText('已送入630K打印队列');
    await button('返回单据').click();await button('再次打印').click();
    await page.getByText(/远程打印到店里/).click();
    await expect(button('再打印一份')).toBeEnabled();
    assert.equal(JSON.parse(fs.readFileSync(process.env.WAREHOUSE_REMOTE_PRINT_FILE)).jobs.length,2,'reopening preview only queries the last job');
    await button('返回单据').click();await button('历史单据').click();
    await expect(page.getByText(/^打印时间：/)).toBeVisible();
    await button('重新打印').click();
    await expect(page.getByRole('dialog',{name:'送货单预览'})).toBeVisible();
    await expect(frame().locator('body')).not.toContainText('打印时间');
    await page.getByText(/远程打印到店里/).click();
    await expect(button('再打印一份')).toBeEnabled();
    await page.getByText(/远程打印到店里/).click();
    await page.screenshot({ path: path.join(artifacts, 'mobile-preview.png'), fullPage: true });
    await expect(page.getByLabel('预览纸张')).toHaveCount(0);
    await page.getByRole('button', { name: '放大送货单预览' }).click();
    await expect(page.getByRole('button', { name: '缩小送货单预览' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '缩小预览' }).click();
    await expect(page.getByRole('button', { name: '放大送货单预览' })).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => { window.__printCalls = 0; window.print = () => window.__printCalls++; });
    await button('打印送货单').click(); assert.equal(await page.evaluate(() => window.__printCalls), 1);
    await expect(page.locator('[data-dot-matrix-print-root]')).toHaveCount(1);
    assert.equal(await page.locator('[data-dot-matrix-print-root] tr[data-line]').count(), 1);
    if (engine === 'chromium') {
      const pdf = await page.pdf({ path: path.join(artifacts, 'delivery-241-93.pdf'), preferCSSPageSize: true, printBackground: false });
      assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1);
    }
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page.locator('[data-dot-matrix-print-root]')).toHaveCount(0);
    await button('返回单据').click();
    await button('＋ 新建').click();
    for (const width of [320, 375, 430, 1280]) { await page.setViewportSize({ width, height: 900 }); await noOverflow(); await actionsFollowForm(); }
    await page.setViewportSize({ width: 320, height: 480 });
    await page.getByLabel('第1项备注').focus();
    await page.getByLabel('第1项备注').scrollIntoViewIfNeeded();
    await actionsFollowForm();
    const focusedField = await page.getByLabel('第1项备注').evaluate(input => { const rect=input.getBoundingClientRect();return document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===input; });
    assert.ok(focusedField, 'focused lower input stays unobstructed in a keyboard-height viewport');
    await page.screenshot({ path: path.join(artifacts, 'desktop-editor.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    saved = db.listPrintNotes()[0];
    const multiProducts = Array.from({ length: 12 }, (_, index) => db.addProduct({
      name: '多页纸箱 ' + (index + 1),
      specification: '600×400×' + (100 + index),
      unit: '个', stock: 20, price: 1.23456
    }));
    const multi = db.savePrintNote({
      company: saved.company,
      customer_id: saved.customer_id,
      customer_name: '多页送货客户',
      address: saved.address,
      phone: saved.phone,
      receiver: saved.receiver,
      sender: saved.sender,
      date: saved.date,
      paper: saved.paper,
      items: multiProducts.map((item, index) => ({
        product_id: item.id,
        name: item.name,
        specification: item.specification,
        unit: '个',
        quantity: 10,
        price: 1.23456,
        remark: '多页测试 ' + (index + 1)
      }))
    });
    await button('当前单据').click(); failHistory = true; await button('历史单据').click();
    await expect(page.getByRole('alert')).toContainText('测试历史加载失败');
    await button('重试').click(); await page.getByRole('button', { name: /多页送货客户/ }).click();
    await button('编辑单据').click();
    await actionsFollowForm();
    await page.getByLabel('第12项备注').focus();
    await page.getByLabel('第12项备注').scrollIntoViewIfNeeded();
    await actionsFollowForm();
    await main.evaluate(element=>{element.scrollTop=element.scrollHeight;});
    const multiEndLayout = await actionLayout();
    assert.ok(multiEndLayout.bottom <= multiEndLayout.viewportBottom - multiEndLayout.paddingBottom + 1, 'multi-item form keeps its final actions above bottom navigation');
    await page.getByLabel('第1项备注').fill('我的待保存修改');
    db.savePrintNote({ ...multi, sender: '另一个设备' }, multi.id);
    await button('保存单据').click(); await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('第1项备注')).toHaveValue('我的待保存修改');
    assert.equal(db.listPrintNotes().find(note => note.id === multi.id).sender, '另一个设备');
    await button('＋ 新建').click(); await button('放弃并继续').click();
    await page.goto(origin + '/#/pages/print-center/index'); await page.reload();
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await button('查找单据').click(); await page.getByRole('button', { name: /多页送货客户/ }).click();
    await button('编辑单据').click();
    await button('确认出库并打印').click();
    await expect.poll(() => db.listPrintNotes().find(note => note.id === multi.id).outbound_at).toBeTruthy();
    await expect(button('打印送货单')).toBeEnabled();
    await expect(frame().locator('tr[data-line]')).toHaveCount(12);
    await expect(frame().locator('.sheet')).toHaveCount(3);
    await page.evaluate(() => { window.__printCalls = 0; window.print = () => window.__printCalls++; });
    await button('打印送货单').click();
    assert.equal(await page.evaluate(() => window.__printCalls), 1);
    assert.equal(await page.locator('[data-dot-matrix-print-root] tr[data-line]').count(), 12);
    if (engine === 'chromium') {
      const pdf = await page.pdf({ path: path.join(artifacts, 'delivery-multipage.pdf'), preferCSSPageSize: true });
      assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 3);
    }
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page.locator('[data-dot-matrix-print-root]')).toHaveCount(0);
    await button('返回单据').click();
    const counterCustomer = db.addCustomer({ name: '打印台计数客户' });
    for (let index = 0; index < 31; index += 1) {
      db.savePrintNote({
        company: counterCustomer.name, customer_id: counterCustomer.id, customer_name: counterCustomer.name,
        receiver: '计数收件人 ' + index, phone: '13800000000', address: '计数地址', sender: '计数发货人',
        date: '2026-10-28', paper: saved.paper,
        items: [{ name: '计数纸箱', specification: '30×20×15', quantity: 1, unit: '个', price: 1, remark: '' }]
      });
    }
    const countTotal = db.listPrintNotes().length;
    assert.ok(countTotal > 30, 'seed more notes than one history page');
    await page.goto(origin + '/#/pages/print-center/index'); await page.reload();
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await expect(page.locator('[class*="recentHeading"] p')).toContainText(`共 ${countTotal} 张`);
    await page.getByRole('button', { name: '全部单据', exact: true }).click();
    await expect(page.getByText('SH-20261028-00033', { exact: false }).first()).toBeVisible();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine, savedEditReload: 'passed', customersAndStaleSearch: 'passed', saveFailure: 'passed', conflict: 'passed', mobileWidths: [320, 375, 390, 430], twoDigitSpecification: 'passed', previewZoom: 'passed', paperSelector: 'removed', multipage: 12, screenshots: artifacts }));
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }); console.error((await page.locator('body').innerText()).slice(0, 2200)); }
    throw error;
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

