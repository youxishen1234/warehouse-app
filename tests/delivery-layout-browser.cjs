// Tests the source renderer directly while the shared app build waits for other tasks.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { chromium, webkit } = require('@playwright/test');
const filename = path.resolve('src/utils/dot-matrix-print.ts');
const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const loaded = new Module(filename, module); loaded._compile(source, filename);
const { buildDotMatrixHtml, normalizePrintSettings } = loaded.exports;

async function main() {
  const engine = process.env.PRINT_BROWSER || 'chromium';
  const browser = await (engine === 'webkit' ? webkit : chromium).launch();
  const artifactDir = path.resolve('release/print-center-01a1211e/layout', engine);
  fs.mkdirSync(artifactDir, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const doc = { key: 'layout-test', number: 'SH-DEMO', title: '送货单', party: '华兴包装（演示）', address: '河北省沧州市东光县工业园', phone: '13800000000', receiver: '王先生', operator: '张师傅', orderNumber: '', date: '2026-10-09',
      lines: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, product_id: 0, type: 'out', created_at: 0, product_name: '五层瓦楞纸箱 ' + (i + 1), specification: '400mm x 300mm * 200mm', unit: '个', quantity: 100, unit_price: 1.23456, amount: 123.46, remark: '轻拿轻放', operator: '' })) };
    for (const paper of ['241-93', '241-140', 'a4']) {
      const settings = normalizePrintSettings({ template: 'delivery-note', paper });
      await page.setContent(buildDotMatrixHtml(doc, settings));
      const layout = await page.evaluate(async ({ code, documentData, printSettings }) => {
        const exports = {}; new Function('exports', code)(exports);
        await document.fonts.ready;
        return exports.paginateDotMatrixDocument(document, documentData, printSettings);
      }, { code: source, documentData: doc, printSettings: settings });
      assert.equal(await page.locator('tr[data-line]').count(), 12);
      assert.equal(layout.pages, paper === '241-93' ? 3 : paper === '241-140' ? 2 : 1);
      assert.equal(await page.locator('.spec').first().textContent(), '400×300×200');
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.delivery-content')].every(content => content.getBoundingClientRect().right <= content.parentElement.getBoundingClientRect().right)), true);
      await page.locator('.sheet').first().screenshot({ path: path.join(artifactDir, paper + '.png') });
      if (engine === 'chromium') {
        const pdf = await page.pdf({ path: path.join(artifactDir, paper + '.pdf'), preferCSSPageSize: true, printBackground: false });
        assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, layout.pages);
      }
    }
    // Long text must move intact to another page, or give an explicit layout error.
    const longDoc = { ...doc, lines: doc.lines.map((line, i) => ({ ...line, remark: i === 0 ? '请核对外箱尺寸，收货时检查数量与包装是否完好。' : line.remark })) };
    const settings = normalizePrintSettings({ template: 'delivery-note', paper: '241-93' });
    await page.setContent(buildDotMatrixHtml(longDoc, settings));
    await page.evaluate(async ({ code, documentData, printSettings }) => {
      const exports = {}; new Function('exports', code)(exports); await document.fonts.ready;
      exports.paginateDotMatrixDocument(document, documentData, printSettings);
    }, { code: source, documentData: longDoc, printSettings: settings });
    assert.equal(await page.locator('tr[data-line]').count(), 12);
    const oversized = { ...doc, lines: [{ ...doc.lines[0], remark: '请核对外箱尺寸，收货时检查数量与包装是否完好。'.repeat(10) }] };
    await page.setContent(buildDotMatrixHtml(oversized, settings));
    await assert.rejects(page.evaluate(async ({ code, documentData, printSettings }) => {
      const exports = {}; new Function('exports', code)(exports); await document.fonts.ready;
      exports.paginateDotMatrixDocument(document, documentData, printSettings);
    }, { code: source, documentData: oversized, printSettings: settings }), /放不下/);
    console.log(JSON.stringify({ engine, papers: 3, twelveLinesPreserved: true, longRemarks: true, artifacts: artifactDir }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
