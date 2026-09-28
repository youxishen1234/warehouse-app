from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
needle='| 95 | 已通过 | `backend/team.js`：流水 CSV、账本 CSV 复用同一安全单元格编码 | `backend/stock.test.cjs` |'
insert=needle+'\n| 167 | 已通过 | API 响应统一返回 X-Request-Id，便于日志与问题追踪 | `backend/team.test.cjs` |\n| 233 | 已通过 | API 增加 nosniff、DENY、no-referrer、Permissions-Policy 安全响应头；隐藏 Express X-Powered-By | `backend/team.test.cjs` |'
s=s.replace(needle,insert)
p.write_text(s,encoding='utf-8')
