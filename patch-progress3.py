from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
marker='| 27 | 已通过 | `backend/db.js`：送货单运费生成 expense 账本流水；整单作废同步作废 | `backend/stock.test.cjs` |'
insert=marker+'\n| 49 | 已通过 | 客户/供应商创建期初余额时同步生成 receivable/payable 账本流水 | `backend/stock.test.cjs` |\n| 50 | 已通过 | 客户 debt、供应商 payable 上调/下调分别生成 receivable/payable 或 settlement 流水 | `backend/stock.test.cjs` |'
s=s.replace(marker,insert)
s=s.replace('- `cd backend && npm test`：16/16 通过。','- `cd backend && npm test`：17/17 通过。')
p.write_text(s,encoding='utf-8')
