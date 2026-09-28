const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const install = require('./team');
const updates = require('./updates');

test('native package downloads emit an auditable IP, device, platform and version event', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-package-download-'));
  const dataFile = path.join(dir, 'data.json');
  const accountsFile = path.join(dir, 'accounts.json');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], orders: [], ledger: [], _meta: { nextProductId: 1, nextCustomerId: 1, nextSupplierId: 1, nextTransactionId: 1, nextLedgerId: 1 } }));
  const password = 'Package-download-password!';
  await install.bootstrap(accountsFile, password);
  const previousData = process.env.WAREHOUSE_DATA_FILE;
  const previousAccounts = process.env.WAREHOUSE_ACCOUNTS_FILE;
  const previousDownloadsLimit = process.env.WAREHOUSE_APP_DOWNLOADS_RATE_LIMIT;
  const previousReportLimit = process.env.WAREHOUSE_APPUPDATE_REPORT_RATE_LIMIT;
  process.env.WAREHOUSE_DATA_FILE = dataFile;
  process.env.WAREHOUSE_ACCOUNTS_FILE = accountsFile;
  process.env.WAREHOUSE_APP_DOWNLOADS_RATE_LIMIT = '3';
  process.env.WAREHOUSE_APPUPDATE_REPORT_RATE_LIMIT = '2';

  const packagePath = path.join(__dirname, 'public', 'shuguang.ipa');
  const manifestDir = path.join(__dirname, 'public', 'appupdate');
  const manifestPath = path.join(manifestDir, 'manifest.json');
  const hadManifest = fs.existsSync(manifestPath);
  const previousManifest = hadManifest ? fs.readFileSync(manifestPath) : null;
  const packageBody = Buffer.from('test-ipa-package');
  const originalLogEvent = updates.logEvent;
  const events = [];
  updates.logEvent = event => { events.push(event); return event; };
  fs.mkdirSync(manifestDir, { recursive: true });
  const packageDigest = require('node:crypto').createHash('sha256').update(packageBody).digest('hex');
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: '2026.09.27-test',
    url: 'www.zip',
    publishedAt: '2026-09-27T00:00:00Z',
    size: packageBody.length,
    sha256: packageDigest,
    integrity: { algorithm: 'sha256', value: packageDigest }
  }));
  fs.writeFileSync(packagePath, packageBody, { flag: 'wx' });

  // server.js reads the environment and the shared update module at import time.
  const app = require('./server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const staticManifest = await fetch(`${origin}/appupdate/manifest.json`);
    assert.equal(staticManifest.status, 200);
    assert.equal(staticManifest.headers.get('cache-control'), 'no-store');

    const response = await fetch(`${origin}/shuguang.ipa?current=1.2.3`, {
      headers: { 'X-Warehouse-Device': 'package-test-device' }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="shuguang.ipa"');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), packageBody);
    await new Promise(resolve => setImmediate(resolve));

    const check = await fetch(`${origin}/api/appupdate/check?device_id=package-test-device&platform=ios&native_version=1.0.0&current=2026.09.26-test`);
    assert.equal(check.status, 200);
    assert.equal(check.headers.get('cache-control'), 'no-store');
    const checkBody = await check.json();
    assert.deepEqual(checkBody.data.integrity, { algorithm: 'sha256', value: packageDigest });
    assert.equal(checkBody.data.sha256, packageDigest);
    assert.equal(checkBody.data.size, packageBody.length);
    assert.equal(Object.prototype.hasOwnProperty.call(checkBody.data, 'path'), false);

    const invalidDownloads = await fetch(`${origin}/api/app/downloads?foo=bar`);
    assert.equal(invalidDownloads.status, 400);
    assert.equal(invalidDownloads.headers.get('cache-control'), 'no-store');
    const originalReadManifest = updates.readManifest;
    updates.readManifest = () => { throw new Error(`internal manifest path: ${manifestPath}`); };
    try {
      const failedDownloads = await fetch(`${origin}/api/app/downloads`, { headers: { 'X-Request-Id': 'download-error-contract' } });
      assert.equal(failedDownloads.status, 500);
      assert.equal(failedDownloads.headers.get('x-request-id'), 'download-error-contract');
      const failedBody = await failedDownloads.json();
      assert.deepEqual(failedBody, { success: false, message: '???????????' });
      assert.equal(JSON.stringify(failedBody).includes(manifestPath), false);
    } finally {
      updates.readManifest = originalReadManifest;
    }
    const downloads = await fetch(`${origin}/api/app/downloads`);
    assert.equal(downloads.status, 200);
    assert.equal(downloads.headers.get('cache-control'), 'no-store');
    const downloadsBody = await downloads.json();
    assert.equal(downloadsBody.success, true);
    assert.equal(downloadsBody.data.ipaSize, packageBody.length);
    assert.equal(downloadsBody.data.ipaSha256, packageDigest);
    assert.equal(downloadsBody.data.apk, null);
    assert.equal(downloadsBody.data.apkSha256, null);
    assert.equal(Object.prototype.hasOwnProperty.call(downloadsBody.data, 'backendPath'), false);
    const limitedResponses = [];
    for (let index = 0; index < 3; index += 1) limitedResponses.push(await fetch(`${origin}/api/app/downloads`));
    const limited = limitedResponses.find(response => response.status === 429);
    assert.ok(limited, 'download metadata should be rate limited');
    assert.equal(limited.headers.get('retry-after'), '60');

    const reportBefore = events.length;
    const report = await fetch(`${origin}/api/appupdate/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'downloaded', device_id: 'package-test-device', platform: 'ios', current: '2026.09.26-test', to_version: '2026.09.27-test' })
    });
    assert.equal(report.status, 200);
    assert.equal(report.headers.get('cache-control'), 'no-store');
    const originalReportLog = updates.logEvent;
    const originalConsoleError = console.error;
    let reportErrorLog = '';
    updates.logEvent = () => { throw new Error(`internal report path: ${manifestPath}`); };
    console.error = (prefix, payload) => { if (prefix === '[api-error]') reportErrorLog = String(payload); };
    try {
      const failedReport = await fetch(`${origin}/api/appupdate/report`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'report-error-contract', 'X-Warehouse-Device': 'report-error-device' }, body: JSON.stringify({ event: 'downloaded', device_id: 'report-error-device', platform: 'ios' }) });
      assert.equal(failedReport.status, 500);
      assert.equal(failedReport.headers.get('x-request-id'), 'report-error-contract');
      const failedBody = await failedReport.json();
      assert.equal(failedBody.success, false);
      assert.doesNotMatch(JSON.stringify(failedBody), /internal report path|appupdate.*manifest/i);
      const loggedError = JSON.parse(reportErrorLog);
      assert.equal(loggedError.requestId, 'report-error-contract');
      assert.equal(loggedError.method, 'POST');
      assert.equal(loggedError.path, '/api/appupdate/report');
      assert.equal(loggedError.status, 500);
    } finally {
      updates.logEvent = originalReportLog;
      console.error = originalConsoleError;
    }
    const rejectedReport = await fetch(`${origin}/api/appupdate/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Warehouse-Device': 'report-invalid-device' },
      body: JSON.stringify({ event: 'installed', message: '<script>alert(1)</script>' })
    });
    assert.equal(rejectedReport.status, 400);
    assert.equal(events.length, reportBefore + 1);
    const reportResponses = [];
    for (let index = 0; index < 3; index += 1) reportResponses.push(await fetch(`${origin}/api/appupdate/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Warehouse-Device': 'report-rate-device' },
      body: JSON.stringify({ event: 'downloaded', device_id: 'report-rate-device', platform: 'ios' })
    }));
    const reportLimited = reportResponses.find(response => response.status === 429);
    assert.ok(reportLimited, 'report endpoint should be rate limited');
    assert.equal(reportLimited.headers.get('retry-after'), '60');

    const packageBytes = fs.readFileSync(packagePath);
    fs.unlinkSync(packagePath);
    try {
      const missingPackage = await fetch(`${origin}/shuguang.ipa`, { headers: { 'X-Request-Id': 'missing-package-contract' } });
      assert.equal(missingPackage.status, 404);
      assert.equal(missingPackage.headers.get('x-request-id'), 'missing-package-contract');
      assert.match(missingPackage.headers.get('content-type') || '', /application\/json/);
      const missingBody = await missingPackage.json();
      assert.deepEqual(missingBody, { success: false, message: '安装包不存在或暂不可用' });
      assert.equal(JSON.stringify(missingBody).includes(__dirname), false);
    } finally {
      fs.writeFileSync(packagePath, packageBytes);
    }

    const event = events.find(item => item.event === 'package_download');
    assert.ok(event, 'package download should be logged after the response finishes');
    assert.equal(event.platform, 'ios');
    assert.equal(event.device_id, 'package-test-device');
    assert.equal(event.current, '1.2.3');
    assert.equal(event.to_version, '2026.09.27-test');
    assert.match(event.ip, /127\.0\.0\.1|::ffff:127\.0\.0\.1/);
    assert.match(event.message, /shuguang\.ipa 200/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    updates.logEvent = originalLogEvent;
    try { fs.unlinkSync(packagePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (hadManifest) fs.writeFileSync(manifestPath, previousManifest);
    else {
      try { fs.unlinkSync(manifestPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { fs.rmdirSync(manifestDir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
    }
    if (previousData === undefined) delete process.env.WAREHOUSE_DATA_FILE;
    else process.env.WAREHOUSE_DATA_FILE = previousData;
    if (previousAccounts === undefined) delete process.env.WAREHOUSE_ACCOUNTS_FILE;
    else process.env.WAREHOUSE_ACCOUNTS_FILE = previousAccounts;
    if (previousDownloadsLimit === undefined) delete process.env.WAREHOUSE_APP_DOWNLOADS_RATE_LIMIT;
    else process.env.WAREHOUSE_APP_DOWNLOADS_RATE_LIMIT = previousDownloadsLimit;
    if (previousReportLimit === undefined) delete process.env.WAREHOUSE_APPUPDATE_REPORT_RATE_LIMIT;
    else process.env.WAREHOUSE_APPUPDATE_REPORT_RATE_LIMIT = previousReportLimit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
