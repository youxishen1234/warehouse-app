const path = require('node:path');
const { webkit } = require(path.join(process.env.TEMP, 'warehouse-release-tools/node_modules/@playwright/test'));

(async () => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://youxishen.online/workspace/');
    await page.waitForTimeout(2500);
    const text = await page.locator('body').innerText();
    if (text.includes('暂无本地数据') || text.includes('离线模式')) throw new Error('Offline indicator remained');
    if (!text.includes('商品种类')) throw new Error('Home did not render');
    if (errors.length) throw new Error(errors.join('\n'));
    await page.screenshot({ path: 'release/build13-live-home.png', fullPage: true });
    console.log('Live WebKit workspace loaded shared data without offline state.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
