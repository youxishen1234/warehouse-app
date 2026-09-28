const fs = require('fs');
const f = 'E:/aoo/warehouse-app/docs/曙光库存-优化建议3000条.md';
const md = fs.readFileSync(f, 'utf8');
const nums = [...md.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]));
console.log('编号条数:', nums.length);
let ok = true;
for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) { console.log('编号断裂 at', i + 1, 'got', nums[i]); ok = false; break; }
console.log('编号 1..3000 连续:', ok);
const bodies = [...md.matchAll(/^\d+\. (.+)$/gm)].map(m => m[1].replace(/\s+/g, ''));
const set = new Set(bodies);
console.log('正文去重后:', set.size, '重复:', bodies.length - set.size);
console.log('空条目:', bodies.filter(b => b.length < 5).length);
