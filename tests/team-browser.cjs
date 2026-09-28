const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
(async () => {
  const { server, db } = await require('../scripts/team-preview.cjs')();
  const base = 'http://127.0.0.1:4186';
  // 应用启动会自动以游客身份连接共享仓库（无登录表单），请求会按 sessionOrigin 顺序
  // 尝试 152.136.100.200 / youxishen.online；测试将两个来源都重写到本地预览后端，
  // 保证测试不依赖外部服务器。
  const origins = ['http://152.136.100.200', 'https://youxishen.online'];
  const browser = await (process.env.TEAM_BROWSER === 'webkit' ? webkit : chromium).launch();
  try {
    const errors = [];
    async function page(viewport) {
      const context = await browser.newContext({ viewport });
      for (const origin of origins) {
        await context.route(origin + '/**', async route => {
          const url = new URL(route.request().url());
          const result = await route.fetch({ url: base + url.pathname + url.search });
          await route.fulfill({ response: result, headers: { ...result.headers(), 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization, If-Match, Idempotency-Key, X-Warehouse-Device', 'access-control-expose-headers': 'X-Warehouse-Revision', 'access-control-max-age': '600' } });
        });
      }
      const p = await context.newPage();
      p.on('pageerror', e => errors.push(e.message));
      return p;
    }
    async function visibleClick(p, text) {
      await p.evaluate(t => {
        const pages = Array.from(document.querySelectorAll('.taro_page'))
          .filter(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0);
        const page = pages[pages.length - 1];
        if (!page) throw new Error('no visible taro_page for ' + t);
        const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
        let node, target = null;
        while ((node = walker.nextNode())) {
          if (node.textContent.trim() === t) { target = node.parentElement; break; }
        }
        if (!target) throw new Error('visible text not found: ' + t);
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }, text);
    }

    // 手机端：打开即游客连接，首页渲染，无登录表单、无连接遮罩
    const a = await page({ width: 390, height: 844 });
    await a.goto(base);
    await a.getByText('功能入口', { exact: true }).waitFor({ timeout: 15000 });
    await a.locator('.team-boot').waitFor({ state: 'detached', timeout: 15000 });
    assert.equal(await a.locator('.team-login').count(), 0, 'no login form in guest mode');
    const session = await a.evaluate(() => localStorage.getItem('warehouse_session_v1'));
    assert.ok(session, 'guest session was stored');
    const user = JSON.parse(session).data.user;
    assert.equal(user.role, 'operator', 'guest connects as operator');
    assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    await a.screenshot({ path: 'release/team-home.png', fullPage: true });
    console.log('Guest auto-connect and homepage rendered (mobile)', a.url());

    // 手机端：游客直接新增商品（单人使用不需要登录，guest 可写）
    await visibleClick(a, '商品管理');
    await a.getByText('+ 新增', { exact: true }).waitFor({ timeout: 10000 });
    await visibleClick(a, '+ 新增');
    const nameInput = a.getByPlaceholder('请输入商品名称').first().locator('input');
    await nameInput.waitFor({ timeout: 10000 });
    await nameInput.fill('Shared carton');
    await a.getByText('保存', { exact: true }).click();
    await a.getByText('Shared carton', { exact: true }).last().waitFor({ timeout: 15000 });
    await a.screenshot({ path: 'release/team-product-added.png', fullPage: true });
    console.log('Guest added a product through the UI');

    // Mobile: partial settlement uses the in-page modal and records the new balance.
    const partialCustomer = db.addCustomer({ name: 'Partial settlement customer', debt: 100 });
    await a.goto(base + '/pages/customers/index');
    await a.getByText('Partial settlement customer', { exact: true }).waitFor({ timeout: 15000 });
    await a.getByText('结算', { exact: true }).click();
    await a.locator('input').first().fill('40');
    await a.getByText('确认结算', { exact: true }).click();
    for (let attempt = 0; attempt < 30 && db.getCustomer(partialCustomer.id).debt !== 60; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(db.getCustomer(partialCustomer.id).debt, 60);
    assert(db.listLedger({ type: 'settlement' }).some(row => row.party_id === partialCustomer.id && row.amount === 40));
    console.log('Partial customer settlement through the UI passed');

    // 桌面端：新会话再次打开，能读取到共享数据（商品已持久化到后端）
    const b = await page({ width: 1280, height: 900 });
    await b.goto(base);
    await b.getByText('功能入口', { exact: true }).waitFor({ timeout: 15000 });
    await b.locator('.team-boot').waitFor({ state: 'detached', timeout: 15000 });
    await visibleClick(b, '商品管理');
    await b.getByText('Shared carton', { exact: true }).last().waitFor({ timeout: 15000 });
    assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow on desktop');
    await b.screenshot({ path: 'release/team-shared-products.png', fullPage: true });
    console.log('Two sessions: shared product visible, no JS errors');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
