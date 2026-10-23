const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename=path.resolve('src/pages/print-center/specification-input.ts');
const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=module.paths;
loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,filename);
const {formatSpecificationInput:format}=loaded.exports;
test('two-digit dimensions insert separators during numeric typing and accept pasted dimensions',()=>{
 let value=''; for(const digit of '302015')value=format(value+digit,value);
 assert.equal(value,'30×20×15');
 assert.equal(format('3'),'3');assert.equal(format('30'),'30×');
 assert.equal(format('3020'),'30×20×');
 assert.equal(format('302015'),'30×20×15');
 assert.equal(format('40x30*20'),'40×30×20');
 assert.equal(format('30×20×15'),'30×20×15');
 assert.equal(format('30×20×1','30×20×15'),'30×20×1');
 assert.equal(format('30','30×'),'30');
 assert.equal(format('3','30'),'3');
 assert.equal(format(''),'');
});

test('two-dimensional board input stops adding a separator after the width', () => {
 let value = ''; for (const digit of '3020') value = format(value + digit, value, 2);
 assert.equal(value, '30×20');
 assert.equal(format('30', '', 2), '30×');
 assert.equal(format('3020', '', 2), '30×20');
 assert.equal(format('30', '30×', 2), '30');
 assert.equal(format('30×2', '30×20', 2), '30×2');
 assert.equal(format('', '30×20', 2), '');
 assert.equal(format('302015', '', 2), '30×20×15');
});
