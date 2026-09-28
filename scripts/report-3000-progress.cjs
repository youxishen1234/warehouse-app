const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const docs = path.join(root, 'docs');
const sourceName = '曙光库存-优化建议3000条.md';
const progress = fs.readFileSync(path.join(docs, '3000-progress.md'), 'utf8');
const source = fs.readFileSync(path.join(docs, sourceName), 'utf8');
const records = new Map();
for (const line of progress.split(/\r?\n/)) {
  const fields = line.split('|').map(value => value.trim());
  if (!/^\d+(?:\/\d+)*$/.test(fields[1] || '')) continue;
  for (const id of fields[1].split('/').map(Number)) {
    const entries = records.get(id) || [];
    entries.push({ state: fields[2], implementation: fields[3], evidence: fields.slice(4, -1).filter(Boolean).join('；') });
    records.set(id, entries);
  }
}

let section = '';
const items = [];
for (const line of source.split(/\r?\n/)) {
  if (line.startsWith('## ')) section = line.slice(3);
  const match = /^(\d+)\.\s+(.+)$/.exec(line);
  if (!match) continue;
  const id = Number(match[1]);
  const entries = records.get(id) || [];
  const state = !entries.length ? '待实施／待核对' : entries.every(entry => ['已通过', '已完成'].includes(entry.state)) ? '记录已完成' : '部分完成／待验证';
  items.push({ id, text: match[2], section, state, entries });
}
assert.equal(items.length, 3000, '原始清单必须包含 3000 条');
assert.deepEqual(items.map(item => item.id), Array.from({ length: 3000 }, (_, index) => index + 1), '编号必须连续且不重复');
for (const id of records.keys()) assert(id >= 1 && id <= 3000, `实施记录存在清单以外编号 ${id}`);
const states = ['记录已完成', '部分完成／待验证', '待实施／待核对'];
const count = (state, subset = items) => subset.filter(item => item.state === state).length;
const date = /更新时间：([^\r\n]+)/.exec(progress)?.[1] || '未记录';
const output = [
  '# 3000 条优化清单：完成与未完成对照', '',
  `核对日期：${date}`, '',
  `依据：[原始清单](./${sourceName})、[实施和验证记录](./3000-progress.md)。`, '',
  '> 这是实施记录的逐编号对照，不是对 3000 条原始验收要求的全量重新审计。',
  '> “记录已完成”表示实施记录已有完成状态和证据；“部分完成／待验证”仍有明确缺口；“待实施／待核对”表示没有完成记录，不代表代码中完全没有相关能力。',
  '> 同一编号的多次改动只计一次；组合编号拆开计数。设备实测、部署、上传和业务上线不能由编译成功替代。', '',
  ...states.map(state => `- ${state}：${count(state)} 条`),
  '- 总计：3000 条', '',
  '## 已登记完成的编号', '',
  items.filter(item => item.state === states[0]).map(item => item.id).join('、'), '',
  '## 部分完成与待验证的缺口', ''
];
for (const item of items.filter(candidate => candidate.state === states[1])) {
  output.push(`- **${item.id}**：${item.text}`);
  for (const entry of item.entries) output.push(`  - ${entry.state}：${entry.implementation}；证据／缺口：${entry.evidence || '待补充'}`);
}
output.push('', '## 各模块数量', '', '| 模块 | 记录已完成 | 部分完成／待验证 | 待实施／待核对 | 总数 |', '| --- | ---: | ---: | ---: | ---: |');
for (const name of new Set(items.map(item => item.section))) {
  const subset = items.filter(item => item.section === name);
  output.push(`| ${name} | ${states.map(state => count(state, subset)).join(' | ')} | ${subset.length} |`);
}
output.push('', '## 逐条对照（保留原始要求）', '');
section = '';
for (const item of items) {
  if (item.section !== section) { section = item.section; output.push(`### ${section}`, ''); }
  output.push(`- **${item.id} · ${item.state}** ${item.text}`);
  for (const entry of item.entries) output.push(`  - 实施记录：${entry.state}；${entry.implementation}；验证：${entry.evidence || '待补充'}`);
}
output.push('', '本文件由 `node scripts/report-3000-progress.cjs` 生成。请先更新 `docs/3000-progress.md` 的真实实施证据，再重新生成；原始需求文件不会被修改。', '');
const filename = path.join(docs, '3000-status.md');
const content = output.join('\n');
if (process.argv.includes('--check')) assert.equal(fs.readFileSync(filename, 'utf8'), content, '状态文件过期，请重新生成');
else fs.writeFileSync(filename, content, 'utf8');
console.log(JSON.stringify({ file: filename, total: items.length, completed: count(states[0]), partial: count(states[1]), pending: count(states[2]) }));
