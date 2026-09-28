from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 111 | 已通过 | 账本金额改用 numberValue，显式拒绝布尔、空值、文本、负数和超精度输入 | `backend/stock.test.cjs` |', '| 113 | 已通过 | /health 真实检查数据文件可读写、revision 和账号文件可用，不暴露路径 | `backend/team.test.cjs` |\n| 111 | 已通过 | 账本金额改用 numberValue，显式拒绝布尔、空值、文本、负数和超精度输入 | `backend/stock.test.cjs` |')
p.write_text(s,encoding='utf-8')
