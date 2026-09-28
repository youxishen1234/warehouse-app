from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 50 | 已通过 | 客户 debt、供应商 payable 上调/下调分别生成 receivable/payable 或 settlement 流水 | `backend/stock.test.cjs` |', '| 50 | 已通过 | 客户 debt、供应商 payable 上调/下调分别生成 receivable/payable 或 settlement 流水 | `backend/stock.test.cjs` |\n| 51 | 已通过 | 客户/供应商结算继续走现有事务写接口并生成 settlement 账本流水 | `backend/stock.test.cjs`、`src/pages/customers/index.tsx` |\n| 52 | 已通过 | 客户/供应商页面结算弹窗支持部分金额、备注与余额上限校验 | `src/pages/customers/index.tsx`、`npx tsc --noEmit` |')
s=s.replace('- `cd backend && npm test`：19/19 通过。','- `cd backend && npm test`：19/19 通过。\n- `npx tsc --noEmit`：通过。')
p.write_text(s,encoding='utf-8')
