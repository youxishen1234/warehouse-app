from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 102 | 已通过 | 商品、客户、供应商、订单、盘点、送货单、流水列表在同时间戳下按 ID 稳定排序 | `backend/stock.test.cjs` |', '| 103 | 已通过 | 商品资料更新时间与库存更新时间分离，库存变动不再改变商品资料列表排序 | `backend/db.js`、`backend/stock.test.cjs` |\n| 104 | 已通过 | 商品新增 profile_updated_at/stock_updated_at 并兼容旧 updated_at 数据 | `backend/db.js`、`backend/stock.test.cjs` |\n| 105 | 已通过 | 客户/供应商增加 profile_updated_at/balance_updated_at，余额调整不改变资料排序 | `backend/db.js`、迁移兼容 |\n| 102 | 已通过 | 商品、客户、供应商、订单、盘点、送货单、流水列表在同时间戳下按 ID 稳定排序 | `backend/stock.test.cjs` |')
s=s.replace('- `cd backend && npm test`：24/24 通过。','- `cd backend && npm test`：25/25 通过。')
p.write_text(s,encoding='utf-8')
