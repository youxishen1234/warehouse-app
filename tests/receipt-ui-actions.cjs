const { expect } = require('@playwright/test');
async function openGoods(page) {
  const details = page.locator('.demo-dialog details').filter({ has: page.getByText('货物资料 · 查看 / 调整', { exact: true }) }).last();
  if (!await details.evaluate(element => element.hasAttribute('open'))) await details.locator('summary').click();
}
async function chooseReceipt(page, label, fragment) {
  const select = page.getByLabel(label === '选择客户' ? '关联客户' : '常用货物', { exact: true });
  await expect(select).toBeEnabled();
  await expect.poll(async () => select.locator('option').allTextContents()).toContainEqual(expect.stringMatching(typeof fragment === 'string' ? new RegExp(fragment) : fragment));
  const options = await select.locator('option').evaluateAll(elements => elements.map(element => ({ value: element.value, text: element.textContent })));
  const target = options.find(option => option.value && (typeof fragment === 'string' ? option.text.includes(fragment) : fragment.test(option.text)));
  if (!target) throw new Error('Missing receipt option: ' + String(fragment));
  await select.selectOption(target.value);
  const confirm = page.locator('.taro-model__confirm:visible');
  if (await confirm.count()) {
    await confirm.click();
    await expect(confirm).toBeHidden();
  }
  await openGoods(page);
}
module.exports = { openGoods, chooseReceipt };
