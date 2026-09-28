from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 49 | 已通过 | 客户/供应商创建期初余额时同步生成 receivable/payable 账本流水 | `backend/stock.test.cjs` |', '| 49 | 已通过 | 客户/供应商创建期初余额时同步生成 receivable/payable 账本流水 | `backend/stock.test.cjs` |\n| 63 | 已通过 | stats.totalValue 统一 roundDecimal(2) | `backend/stock.test.cjs` |\n| 64 | 已通过 | stats 新增 totalStockByUnit，按单位分组返回并保留旧 totalStock 兼容 | `backend/stock.test.cjs` |')
s=s.replace('- `cd backend && npm test`：17/17 通过。','- `cd backend && npm test`：18/18 通过。')
p.write_text(s,encoding='utf-8')
