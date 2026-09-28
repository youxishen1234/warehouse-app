from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 27 | 已通过 | `backend/db.js`：送货单运费生成 expense 账本流水；整单作废同步作废 | `backend/stock.test.cjs` |', '| 27 | 已通过 | `backend/db.js`：送货单运费生成 expense 账本流水；整单作废同步作废 | `backend/stock.test.cjs` |\n| 33 | 已通过 | 入库作废被后续出库占用时列出阻塞出库流水编号和数量 | `backend/stock.test.cjs` |')
p.write_text(s,encoding='utf-8')
