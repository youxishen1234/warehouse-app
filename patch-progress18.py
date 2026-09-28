from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 102 | 已通过 | 商品、客户、供应商、订单、盘点、送货单、流水列表在同时间戳下按 ID 稳定排序 | `backend/stock.test.cjs` |', '| 85 | 已通过 | 高频数字输入统一清洗非法字符，数量最多 6 位小数，金额最多 2 位 | `src/utils/stock-math.ts`、表单页面、`backend/stock.test.cjs` |\n| 86 | 已通过 | 输入层拒绝科学计数法和十六进制等非业务数字格式，后端仍独立校验 | `backend/stock.test.cjs`、`npx tsc --noEmit` |\n| 87 | 已通过 | 金额/数量输入在前端即时截断超长小数 | 高频表单代码、H5 构建 |\n| 102 | 已通过 | 商品、客户、供应商、订单、盘点、送货单、流水列表在同时间戳下按 ID 稳定排序 | `backend/stock.test.cjs` |')
s=s.replace('- `cd backend && npm test`：22/22 通过。','- `cd backend && npm test`：23/23 通过。')
p.write_text(s,encoding='utf-8')
