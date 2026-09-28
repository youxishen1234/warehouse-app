from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 43 | 已通过 | 实际入库数量允许为 0；只保留计划数量，不创建库存/应付流水；整单作废可安全处理 | `backend/stock.test.cjs` |', '| 30 | 已通过 | 盘点调整按差异金额生成 income/expense 账本流水，盘盈盘亏方向分明 | `backend/stock.test.cjs` |\n| 43 | 已通过 | 实际入库数量允许为 0；只保留计划数量，不创建库存/应付流水；整单作废可安全处理 | `backend/stock.test.cjs` |')
s=s.replace('- `cd backend && npm test`：20/20 通过。','- `cd backend && npm test`：21/21 通过。')
p.write_text(s,encoding='utf-8')
