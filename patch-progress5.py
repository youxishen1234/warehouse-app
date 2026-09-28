from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 49 | 已通过 | 客户/供应商创建期初余额时同步生成 receivable/payable 账本流水 | `backend/stock.test.cjs` |', '| 43 | 已通过 | 实际入库数量允许为 0；只保留计划数量，不创建库存/应付流水；整单作废可安全处理 | `backend/stock.test.cjs` |\n| 49 | 已通过 | 客户/供应商创建期初余额时同步生成 receivable/payable 账本流水 | `backend/stock.test.cjs` |')
s=s.replace('- `cd backend && npm test`：18/18 通过。','- `cd backend && npm test`：19/19 通过。')
p.write_text(s,encoding='utf-8')
