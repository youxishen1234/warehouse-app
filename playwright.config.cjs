const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://127.0.0.1:4174' },
  webServer: {
    command: 'node scripts/preview-download.cjs',
    url: 'http://127.0.0.1:4174/download',
    env: { DOWNLOAD_PREVIEW_PORT: '4174' },
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'iphone', use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
