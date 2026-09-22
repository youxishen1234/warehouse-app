const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

test('shows package metadata and downloads the actual IPA without leaving the page', async ({ page }, testInfo) => {
  test.skip(!process.env.DOWNLOAD_PREVIEW_IPA, 'Set DOWNLOAD_PREVIEW_IPA to the IPA used by prepare:download');
  const metadata = JSON.parse(await fs.readFile('release/download/ipa.json', 'utf8'));
  await page.goto('/download');
  await expect(page.locator('#version')).toHaveText(`${metadata.version} (Build ${metadata.build})`);
  await expect(page.locator('#size')).toHaveText(`${(metadata.sizeBytes / 1048576).toFixed(2)} MiB`);
  expect(await page.locator('.app-icon').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('download.png'), fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载 IPA 文件' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('shuguang.ipa');
  const bytes = await fs.readFile(await download.path());
  expect(bytes.length).toBe(metadata.sizeBytes);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(metadata.sha256);
  await expect(page).toHaveURL(/\/download$/);
});

test('keeps the download link available when metadata fails', async ({ page }) => {
  await page.route('**/download/ipa.json', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('/download/');
  await expect(page.locator('#status')).toHaveText('安装包信息暂不可用');
  await expect(page.getByRole('link', { name: '下载 IPA 文件' })).toHaveAttribute('href', '/shuguang.ipa');
});
