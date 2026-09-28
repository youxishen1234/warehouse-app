from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 215 | 已通过 | `load` 与备份恢复补齐 orders/order_events/stocktakes 计数器 | 后端回归测试通过 |', '| 68 | 已通过 | 备份恢复增加完整健康检查：非负核心数值、重复编号、悬空商品/往来引用、明细结构异常均拒绝，失败不改变在线数据 | `backend/stock.test.cjs` |\n| 215 | 已通过 | `load` 与备份恢复补齐 orders/order_events/stocktakes 计数器 | 后端回归测试通过 |')
s=s.replace('- `cd backend && npm test`：19/19 通过。','- `cd backend && npm test`：20/20 通过。')
p.write_text(s,encoding='utf-8')
