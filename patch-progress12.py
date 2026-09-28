from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 167 | 已通过 | API 响应统一返回 X-Request-Id，便于日志与问题追踪 | `backend/team.test.cjs` |', '| 166 | 已通过 | server.js 处理畸形 JSON、空/超大请求体，返回中文 JSON 错误而非 HTML | 临时 HTTP 集成验证 |\n| 167 | 已通过 | API 响应统一返回 X-Request-Id，便于日志与问题追踪 | `backend/team.test.cjs`、server 集成验证 |\n| 237 | 已通过 | 超大 JSON 请求返回 413 中文 JSON，保留请求 ID | 临时 HTTP 集成验证 |')
p.write_text(s,encoding='utf-8')
