from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 215 | 已通过 | `load` 与备份恢复补齐 orders/order_events/stocktakes 计数器 | 后端回归测试通过 |', '| 117 | 已通过 | 删除 server.js 中被 team.js 遮蔽的重复 stats/products/customers/suppliers/stock/transactions/orders/ledger 路由 | `backend/server.js`、后端测试 |\n| 131 | 已通过 | 业务写路径统一由 team.js 事务路由处理，移除旧的非事务直连写入口 | `backend/server.js`、后端测试 |\n| 164 | 已通过 | server.js 仅在直接运行时监听，导出 app 供测试/集成验证 | `backend/server.js` |\n| 215 | 已通过 | `load` 与备份恢复补齐 orders/order_events/stocktakes 计数器 | 后端回归测试通过 |')
p.write_text(s,encoding='utf-8')
