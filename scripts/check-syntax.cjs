const fs = require('fs');
const src = fs.readFileSync('E:/aoo/warehouse-app/scripts/gen-optimization-list.cjs', 'utf8');
let i = 0, line = 1;
const stack = [];
const pairs = { ')': '(', ']': '[', '}': '{' };
while (i < src.length) {
  const c = src[i];
  if (c === '\n') line++;
  if (c === '/' && src[i + 1] === '/') { while (src[i] !== '\n' && i < src.length) i++; continue; }
  if (c === "'" || c === '"' || c === '`') {
    const q = c; i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') i++;
      if (src[i] === '\n') line++;
      i++;
    }
    i++; continue;
  }
  if (c === '(' || c === '[' || c === '{') stack.push([c, line]);
  if (c === ')' || c === ']' || c === '}') {
    const t = stack.pop();
    if (!t || t[0] !== pairs[c]) console.log('MISMATCH', c, 'line', line, 'top', JSON.stringify(t));
  }
  i++;
}
console.log('remaining stack:', JSON.stringify(stack.slice(-8)));
