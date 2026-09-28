from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 95 | 已通过 | `backend/team.js`：流水 CSV、账本 CSV 复用同一安全单元格编码 | `backend/stock.test.cjs` |', '| 102 | 已通过 | 商品、客户、供应商、订单、盘点、送货单、流水列表在同时间戳下按 ID 稳定排序 | `backend/stock.test.cjs` |\n| 95 | 已通过 | `backend/team.js`：流水 CSV、账本 CSV 复用同一安全单元格编码 | `backend/stock.test.cjs` |')
s=s.replace('- `cd backend && npm test`：21/21 通过。','- `cd backend && npm test`：22/22 通过。')
p.write_text(s,encoding='utf-8')
