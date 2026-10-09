// Integration check: reads real installed printers, renders PDF only, never calls physical printing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNative } = require('../scripts/dot-matrix-native.cjs');

(async () => {
  const printers = await runNative({ action: 'list' });
  assert.ok(printers.length, 'at least one installed printer is required for this integration check');
  const printer = printers.find(item => item.isDefault && !item.unavailable) || printers.find(item => !item.unavailable);
  assert.ok(printer, 'an available installed printer is required');
  const job = {
    id: 'native-render-verification-00001', printerName: printer.name,
    document: { key: 'sample', number: 'VERIFY-001', title: '出 库 单', party: '纸箱打印校验', date: '____年__月__日', orderNumber: '', operator: '', sample: true,
      lines: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, product_id: i + 1, type: 'out', product_name: '五层瓦楞纸箱', specification: '40 × 30 × 20 cm', quantity: 100, unit: '个', amount: 350, unit_price: 3.5, remark: i === 2 ? '<script>window.__injected=true</script>' : '检查全部列和走纸尺寸' })) },
    settings: { paper: 'custom', company: '东光县曙光纸箱包装', width: 241.3, height: 139.7, fontSize: 11, rowsPerPage: 5, offsetX: 0, offsetY: 0, showPrices: true, highClarity: true },
  };
  const result = await runNative({ action: 'verify', job });
  assert.equal(result.kind, 'pdf');
  assert.equal(result.printerName, printer.name);
  assert.equal(result.options.deviceName, printer.name);
  assert.deepEqual(result.options.pageSize, { width: 241300, height: 139700 });
  if (printer.name === 'EPSON LQ-630KII ESC/P2') assert.deepEqual(result.options.dpi, { horizontal: 360, vertical: 180 });
  const pdf = Buffer.from(result.pdf, 'base64');
  const text = pdf.toString('latin1');
  assert.equal((text.match(/\/Type\s*\/Page\b/g) || []).length, result.pages);
  assert.ok(result.pages >= 3, 'all twelve rows are paginated');
  const boxes = [...text.matchAll(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/g)];
  assert.ok(boxes.length);
  for (const box of boxes) {
    assert.ok(Math.abs(Number(box[1]) - 241.3 * 72 / 25.4) < 1);
    assert.ok(Math.abs(Number(box[2]) - 139.7 * 72 / 25.4) < 1);
  }
  await assert.rejects(runNative({ action: 'verify', job: { ...job, printerName: 'NONEXISTENT-PRINTER-VERIFY' } }), /已移除/);
  const offline = printers.find(item => item.offline);
  if (offline) await assert.rejects(runNative({ action: 'verify', job: { ...job, printerName: offline.name } }), /离线/);
  const directory = path.resolve('release/dot-matrix-check');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'native-render-verification.pdf'), pdf);
  fs.writeFileSync(path.join(directory, 'native-printers.json'), JSON.stringify(printers, null, 2));
  console.log(JSON.stringify({ printers, selected: result.printerName, pages: result.pages, dimensions: result.options.pageSize, dpi: result.options.dpi, physicalPrintJobs: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; });
