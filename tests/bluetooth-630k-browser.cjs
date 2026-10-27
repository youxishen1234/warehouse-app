const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const sourcePreview = require('./helpers/print-center-source.cjs');

async function main() {
  const server = sourcePreview({}, { bluetooth: true }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch();
  const artifacts = path.resolve(process.env.PRINT_ARTIFACTS || 'release/bluetooth630k-20261027/ui-final');
  fs.mkdirSync(artifacts, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    const panel = page.locator('[data-transport=bluetooth]');
    const send = page.getByRole('button', { name: '发送到630K蓝牙打印机', exact: true });
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 760 });
      assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Bluetooth UI fits at ' + width + 'px');
      const overflowingButtons = await panel.locator('button:visible').evaluateAll(buttons => buttons.filter(button => {
        const rect = button.getBoundingClientRect();
        return button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1
          || rect.left < -1 || rect.right > innerWidth + 1;
      }).map(button => button.innerText.trim()));
      assert.deepEqual(overflowingButtons, [], 'visible button text fits at ' + width + 'px');
      await page.screenshot({ path: path.join(artifacts, 'bluetooth-630k-' + width + 'px.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 760 });
    await page.evaluate(() => { window.__bluetooth630kTest.failNextRemoteRead = true; });
    await send.click();
    await expect(page.getByRole('alert')).toContainText('测试存储读取异常');
    assert.equal(await page.evaluate(() => window.__bluetooth630kTest.sendCalls.length), 0, 'storage-read failure does not submit a job');
    await page.evaluate(() => window.__bluetooth630kTest.holdQueries());
    await send.click();
    await expect.poll(() => page.evaluate(() => window.__bluetooth630kTest.getActiveQueries())).toBe(1);
    await expect(panel.getByRole('button', { name: '正在处理…', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => window.__bluetooth630kTest.queryCalls.length)).toBeGreaterThan(0);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.__bluetooth630kTest.queryCalls.length), 1, 'a held query excludes later periodic queries');
    await page.getByRole('button', { name: '切换测试单据' }).click();
    await expect(panel).toContainText('TEST-630K-1');
    await expect(send).toHaveCount(0);
    await page.getByRole('button', { name: '切换测试单据' }).click();
    await page.evaluate(() => window.__bluetooth630kTest.disconnect());
    await expect.poll(() => page.evaluate(() => window.__bluetooth630kTest.getState().connected)).toBe(false);
    await page.evaluate(() => window.__bluetooth630kTest.releaseQueries());
    await expect.poll(() => page.evaluate(() => window.__bluetooth630kTest.getActiveQueries())).toBe(0);
    const reconnect = panel.getByRole('button', { name: '重连630K打印电脑', exact: true });
    await expect(reconnect).toBeEnabled();
    await page.waitForTimeout(100);
    const beforeDisconnectWait = await page.evaluate(() => window.__bluetooth630kTest.queryCalls.length);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.__bluetooth630kTest.queryCalls.length), beforeDisconnectWait, 'disconnect stops periodic queries');
    await page.evaluate(() => window.__bluetooth630kTest.setNextQueryStatus('queued'));
    await reconnect.click();
    await expect.poll(() => page.evaluate(() => window.__bluetooth630kTest.getState().job?.status)).toBe('queued');
    await expect(panel).toContainText('已进入 Windows 队列');
    await expect(page.getByRole('button', { name: '已经出纸了', exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => window.__bluetooth630kTest.sendCalls.length), 1, 'the bill is submitted once');
    const ids = await page.evaluate(() => ({ sent: window.__bluetooth630kTest.sendCalls[0].id, queried: window.__bluetooth630kTest.queryCalls }));
    assert.ok(ids.queried.length >= 2); assert.ok(ids.queried.every(id => id === ids.sent), 'polling only queries the original task ID');
    assert.ok(await page.evaluate(() => window.__bluetooth630kTest.maxActiveQueries <= 1), 'queries never overlap');
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.__bluetooth630kTest.queryCalls.length), ids.queried.length, 'queued status stops polling');
    await expect(panel).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'bluetooth-630k-queued-390px.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ bluetoothPolling: 'passed', singleSubmission: 'passed', disconnectPause: 'passed', terminalStop: 'passed', widths: [320, 390, 768] }));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
