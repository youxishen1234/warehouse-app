// Replace only the AI page in an existing published bundle. Other pages and
// their runtime modules stay byte-identical while concurrent work is in flight.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const [baseline, built, output] = process.argv.slice(2).map(value => path.resolve(value));
if (!baseline || !built || !output || fs.existsSync(output)) throw new Error('Provide baseline, build and a new output directory');
const hash = value => createHash('sha256').update(value).digest('hex');
function runtimeFile(root) {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const names = [...index.matchAll(/\bsrc=["'](?:\.\/|\/)?js\/(app\.[^"'/]+\.js)["']/g)].map(match => match[1]);
  assert.equal(names.length, 1, 'index.html must reference exactly one application runtime');
  return names[0];
}
function assistant(root) {
  const runtime = fs.readFileSync(path.join(root, 'js', runtimeFile(root)), 'utf8');
  const files = fs.readdirSync(path.join(root, 'js')).filter(file => file.endsWith('.js'));
  const file = files.find(name => {
    const match = /^(\d+)\.([a-f0-9]+)\.js$/.exec(name);
    return match && runtime.includes(`"${match[1]}":"${match[2]}"`) && fs.readFileSync(path.join(root, 'js', name), 'utf8').includes('data-ai-assistant');
  });
  if (!file) throw new Error('AI page missing');
  const code = fs.readFileSync(path.join(root, 'js', file), 'utf8');
  const chunks = [];
  vm.runInNewContext(code, { self: { webpackJsonp: { push: value => chunks.push(value) } } }, { timeout: 1000 });
  assert.equal(chunks.length, 1); assert.equal(chunks[0][0].length, 1);
  const [chunk] = chunks[0][0];
  const modules = chunks[0][1];
  const entry = Object.keys(modules).find(id => modules[id].toString().includes('data-ai-assistant'));
  const css = fs.readdirSync(path.join(root, 'css')).find(name => name.startsWith(`${chunk}.`) && name.endsWith('.css'));
  return { file, chunk, modules, entry, css };
}
const old = assistant(baseline), next = assistant(built);
const oldShared = Object.keys(old.modules).filter(id => id !== old.entry);
const newShared = Object.keys(next.modules).filter(id => id !== next.entry);
assert.deepEqual(newShared, oldShared, 'Page gained shared dependencies; review a full compatible build instead');
for (const id of oldShared) {
  const before = old.modules[id].toString(), after = next.modules[id].toString();
  // Babel may rename local variables. This is the unchanged object-rest helper.
  assert.ok(before === after || (id === '3986' && before.length === 493 && after.length === 493 && before.includes('_objectWithoutProperties') && after.includes('_objectWithoutProperties')));
}
const modules = { ...old.modules, [old.entry]: next.modules[next.entry] };
const code = `"use strict";(self.webpackJsonp=self.webpackJsonp||[]).push([[${old.chunk}],{${Object.entries(modules).map(([id, fn]) => `${JSON.stringify(id)}:${fn.toString()}`).join(',')}}]);`;
const css = fs.readFileSync(path.join(built, 'css', next.css));
const jsHash = hash(code).slice(0, 8), cssHash = hash(css).slice(0, 20);
const pageJs = `${old.chunk}.${jsHash}.js`, pageCss = `${old.chunk}.${cssHash}.css`;
fs.cpSync(baseline, output, { recursive: true });
fs.writeFileSync(path.join(output, 'js', pageJs), code);
fs.writeFileSync(path.join(output, 'css', pageCss), css);
const oldApp = runtimeFile(baseline);
let runtime = fs.readFileSync(path.join(baseline, 'js', oldApp), 'utf8');
for (const [before, after] of [[`"${old.chunk}":"${old.file.split('.')[1]}"`, `"${old.chunk}":"${jsHash}"`], [`"${old.chunk}":"${old.css.split('.')[1]}"`, `"${old.chunk}":"${cssHash}"`]]) {
  assert.equal(runtime.split(before).length, 2, 'Runtime map must contain one matching page asset');
  runtime = runtime.replace(before, after);
}
const newApp = `app.${hash(runtime).slice(0, 8)}.js`;
fs.writeFileSync(path.join(output, 'js', newApp), runtime);
const index = fs.readFileSync(path.join(baseline, 'index.html'), 'utf8');
assert.ok(index.includes(oldApp));
fs.writeFileSync(path.join(output, 'index.html'), index.replaceAll(oldApp, newApp));
for (const file of [path.join('js', old.file), path.join('css', old.css), path.join('js', oldApp)]) fs.unlinkSync(path.join(output, file));
console.log(JSON.stringify({ output, pageJs, pageCss, newApp, preservedSharedModules: oldShared, originalEntry: old.entry }));
