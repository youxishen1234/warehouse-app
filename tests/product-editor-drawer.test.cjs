const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('product edits stay in the products page and do not restore the retired route', () => {
  const config = fs.readFileSync('src/app.config.ts', 'utf8');
  const products = fs.readFileSync('src/components/BusinessForms/GoodsCatalog/index.tsx', 'utf8');
  assert.doesNotMatch(config, /pages\/product-edit\/index/);
  for (const file of ['index.tsx', 'index.module.scss', 'index.config.ts']) {
    assert.equal(fs.existsSync(`src/pages/product-edit/${file}`), false, 'legacy product page file is removed: ' + file);
  }
  assert.doesNotMatch(products, /navigateTo\(\{ url: [`'"]\/pages\/product-edit/);
  assert.match(products, /setEditor\(\{ productId: null/);
  assert.match(products, /getProduct\(id, \{ forceNetwork: true \}\)/);
  assert.match(products, /maxLength=\{key === 'name' \? 50 : 100\}/);
  assert.match(products, /field\('specification', /);
  assert.match(products, /safety_stock: parsed\.safety!/);
});

test('built web assets contain no retired product page route', { skip: !fs.existsSync('dist') }, () => {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:js|html)$/.test(entry.name)) files.push(path);
    }
  };
  visit('dist');
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /pages\/product-edit\/index/, file);
  }
});
