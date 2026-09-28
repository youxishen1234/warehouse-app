from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8')
s=s.replace('| 52 | 部分完成 | 客户/供应商页面结算弹窗支持部分金额、备注与余额上限校验；尚未补专门 Playwright UI 操作回归 | `src/pages/customers/index.tsx`、`npx tsc --noEmit` |', '| 52 | 已通过 | 客户/供应商页面结算弹窗支持部分金额、备注与余额上限校验 | `tests/team-browser.cjs`、`npx tsc --noEmit` |')
p.write_text(s,encoding='utf-8')
