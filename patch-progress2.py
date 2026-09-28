from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 215 | 部分完成 | `load` 与备份恢复补齐 order_events/stocktakes 计数器 | 后端回归测试通过 |', '| 213 | 已通过 | 订单、盘点、订单事件改用持久化递增计数器，避免 Date.now() 主键碰撞 | `backend/stock.test.cjs` |\n| 214 | 部分完成 | 订单/盘点/订单事件主键已统一为 number 递增；旧数据 load 迁移兼容 | 后端回归测试通过 |\n| 215 | 已通过 | `load` 与备份恢复补齐 orders/order_events/stocktakes 计数器 | 后端回归测试通过 |')
p.write_text(s,encoding='utf-8')
