from pathlib import Path
p=Path('backend/db.js')
s=p.read_text(encoding='utf-8')
s=s.replace("  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('日期格式无效');", "  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('日期格式无效');\n  if (date > localDate()) throw new Error('业务日期不能晚于今天');")
s=s.replace("    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return date.getTime();", "    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {\n      if (localDate(date) > localDate()) throw new Error('盘点日期不能晚于今天');\n      return date.getTime();\n    }")
s=s.replace("  if (Number.isFinite(timestamp)) return timestamp;\n  throw new Error('日期格式无效');", "  if (Number.isFinite(timestamp)) {\n    if (timestamp > Date.now()) throw new Error('盘点日期不能晚于今天');\n    return timestamp;\n  }\n  throw new Error('日期格式无效');")
p.write_text(s,encoding='utf-8')
print('patched dates')
