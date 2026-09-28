from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 43 | 已通过 | 实际入库数量允许为 0；只保留计划数量，不创建库存/应付流水；整单作废可安全处理 | `backend/stock.test.cjs` |', '| 43 | 已通过 | 实际入库数量允许为 0；只保留计划数量，不创建库存/应付流水；整单作废可安全处理 | `backend/stock.test.cjs` |\n| 44 | 已通过 | 实际入库数量超过计划数量时，前端 showModal 二次确认；确认后按实际数量入库 | `tests/stock-browser.cjs` |')
s=s.replace('- `cd backend && npm test`：19/19 通过。','- `cd backend && npm test`：19/19 通过。')
p.write_text(s,encoding='utf-8')
