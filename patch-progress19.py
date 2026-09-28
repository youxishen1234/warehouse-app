from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 102 | 已通过 | 商品、客户、供应商、订单、盘点、送货单、流水列表在同时间戳下按 ID 稳定排序 | `backend/stock.test.cjs` |', '| 111 | 已通过 | 账本金额改用 numberValue，显式拒绝布尔、空值、文本、负数和超精度输入 | `backend/stock.test.cjs` |\n| 102 | 已通过 | 商品、客户、供应商、订单、盘点、送货单、流水列表在同时间戳下按 ID 稳定排序 | `backend/stock.test.cjs` |')
s=s.replace('- `cd backend && npm test`：23/23 通过。','- `cd backend && npm test`：24/24 通过。')
p.write_text(s,encoding='utf-8')
