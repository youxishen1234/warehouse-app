// In-memory component test fixture; does not generate or replace an App build.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const sass = require('sass');

module.exports = function sourcePreview(db) {
  const app = require('express')();
  const cssPath = path.resolve('src/pages/print-center/index.module.scss');
  const css = sass.compile(cssPath).css;
  const classes = Object.fromEntries([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map(match => [match[1], match[1]]));
  const modules = new Map();
  const externals = new Set(['react', 'react-dom', 'react/jsx-runtime', '@tarojs/taro']);
  function visit(file) {
    if (modules.has(file)) return;
    modules.set(file, null);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
    const deps = {};
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const name = match[1];
      if (externals.has(name)) { deps[name] = name; continue; }
      const raw = name.startsWith('@/') ? path.resolve('src', name.slice(2)) : path.resolve(path.dirname(file), name);
      if (raw.endsWith('.scss')) { deps[name] = 'style'; continue; }
      const dependency = [raw, raw + '.ts', raw + '.tsx', raw + '.js', path.join(raw, 'index.ts')].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!dependency) throw new Error('Unknown preview import: ' + name);
      deps[name] = dependency; visit(dependency);
    }
    modules.set(file, { source, deps });
  }
  const entry = path.resolve('src/pages/print-center/index.tsx'); visit(entry);
  const runtime =
    'const modules = ' + JSON.stringify(Object.fromEntries(modules)) + ';\n' +
    'const styles = ' + JSON.stringify(classes) + ';\n' +
    'const pageEntry = ' + JSON.stringify(entry) + ';\n' + fs.readFileSync(path.resolve('tests/helpers/print-center-source-runtime.js'), 'utf8');
  app.use(require('express').json()); app.use('/api', require('../../backend/team')(db));
  app.get('/react.js', (_, response) => response.sendFile(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js')));
  app.get('/react-dom.js', (_, response) => response.sendFile(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js')));
  app.get('/preview.js', (_, response) => response.type('application/javascript').send(runtime));
  app.get('/preview.css', (_, response) => response.type('text/css').send('body{margin:0}.taro_page{width:100%}' + css));
  app.get('*', (_, response) => response.type('html').send('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>送货单源码验收</title><link rel="stylesheet" href="/preview.css"></head><body><div class="taro_page" id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/preview.js"></script></body></html>'));
  return app;
};
