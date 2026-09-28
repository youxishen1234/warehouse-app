from pathlib import Path
p=Path('docs/3000-progress.md')
s=p.read_text(encoding='utf-8').replace('- `cd backend && npm test`：21/21 通过.','- `cd backend && npm test`：22/22 通过。').replace('- `cd backend && npm test`：21/21 通过。','- `cd backend && npm test`：22/22 通过。')
p.write_text(s,encoding='utf-8')
