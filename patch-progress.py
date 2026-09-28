from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 66 | 已通过 | `backend/db.js`、`src/utils/format.ts`、首页：安全库存为 0 不触发预警 | `backend/stock.test.cjs` |', '| 66 | 已通过 | `backend/db.js`、`src/utils/format.ts`、首页：安全库存为 0 不触发预警 | `backend/stock.test.cjs` |\n| 94 | 已通过 | `backend/team.js`：送货单 CSV 对字符串公式前缀加单引号并保留 BOM | `backend/stock.test.cjs` |\n| 95 | 已通过 | `backend/team.js`：流水 CSV、账本 CSV 复用同一安全单元格编码 | `backend/stock.test.cjs` |')
p.write_text(s,encoding='utf-8')
