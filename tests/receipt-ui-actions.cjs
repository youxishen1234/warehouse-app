const { expect } = require('@playwright/test');
const receiptLine = (page, index) => index ? page.getByTestId(`inbound-line-${index}`) : page.getByTestId(/^inbound-line-\d+$/).last();
async function openGoods(page, index) {
  const details = receiptLine(page, index).locator('details').filter({ has: page.getByText('新增 / 修改货物', { exact: true }) });
  if (!await details.evaluate(element => element.hasAttribute('open'))) await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
}
async function chooseQuickReceipt(page, fragment, { index = 1, kind } = {}) {
  const picker = receiptLine(page, index).locator('.quick-spec-picker');
  const trigger = picker.locator('.quick-spec-trigger');
  await expect(trigger).toBeEnabled();
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  if (typeof fragment === 'string') await picker.getByRole('searchbox').fill(fragment);
  let options = picker.locator('.quick-spec-options button').filter({ hasText: fragment });
  if (kind) options = options.filter({ hasText: kind === 'product' ? '已有库存' : /客户常用|供货商常购/ });
  await options.first().click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
}
async function chooseReceipt(page, label, fragment) {
  const isCustomer = label === '选择客户';
  const index = Number(label.match(/货物\s+(\d+)/)?.[1] || 1);
  if (!isCustomer) await openGoods(page, index);
  const select = page.getByLabel(isCustomer ? '关联客户' : index > 1 ? `货物 ${index} 常用货物` : '常用货物', { exact: true });
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
  await openGoods(page, index);
}
module.exports = { openGoods, chooseReceipt, chooseQuickReceipt };
