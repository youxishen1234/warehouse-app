from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 68 | 已通过 | 备份恢复增加完整健康检查：非负核心数值、重复编号、悬空商品/往来引用、明细结构异常均拒绝，失败不改变在线数据 | `backend/stock.test.cjs` |', '| 68 | 已通过 | 备份恢复增加完整健康检查：非负核心数值、重复编号、悬空商品/往来引用、明细结构异常均拒绝，失败不改变在线数据 | `backend/stock.test.cjs` |\n| 69 | 已通过 | 备份恢复通过 transact 递增 revision，防止其他客户端基于旧版本提交 | `backend/stock.test.cjs` |')
s=s.replace('- `cd backend && npm test`：20/20 通过。','- `cd backend && npm test`：21/21 通过。')
p.write_text(s,encoding='utf-8')
