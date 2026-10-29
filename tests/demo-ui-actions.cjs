// Shared semantic actions for the demo layout. Business assertions remain in
// each scenario; this helper follows the visible menus and sheets.
async function clickWorkbenchAction(scope, label) {
  const page = typeof scope.page === 'function' ? scope.page() : scope;
  const active = () => page.locator('.taro_page:visible').last();
  const click = text => page.getByText(new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s*›)?$')).filter({ visible: true }).last()
    .locator('xpath=ancestor-or-self::*[self::button or self::taro-button-core][1]').click();
  if (label === '刷新') return active().getByLabel('刷新服务器数据', { exact: true }).click();
  if (label === '查看库存') return page.locator('.sg-app-nav button[data-tab="2"]').click();
  if (label === '收付款 / 账单') return click('收付款');
  if (label === '供货商账单') {
    await page.getByTestId('finance-tab-supplier').click();
    const details = active().getByText('查看明细 ›', { exact: true }).filter({ visible: true });
    if (await details.count()) await details.first().click();
    return;
  }
  if (label === '盘点 / 调整库存') {
    await active().getByTestId('workbench-carton').first().click();
    return click('库存盘点');
  }
  if (label === '生产') {
    await active().getByTestId('workbench-board').first().click();
    await page.getByText('批次操作', { exact: true }).click();
    return click('生产入库');
  }
  const stockActions = { '纸板入库': '＋ 纸板入库', '领纸板生产': '＋ 生产入库', '生产纸箱并入库': '＋ 纸箱入库' };
  if (stockActions[label]) {
    await click('备货业务');
    return click(stockActions[label]);
  }
  if (label === '新增订单') return click('＋ 客户开单');
  if (label === '票据原件' && !(await active().getByText(label, { exact: true }).filter({ visible: true }).count())) await click('更多');
  return page.getByText(label, { exact: true }).filter({ visible: true }).last()
    .locator('xpath=ancestor-or-self::*[self::button or self::taro-button-core][1]').click();
}
module.exports = { clickWorkbenchAction };
