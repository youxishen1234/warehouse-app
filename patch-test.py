from pathlib import Path
p=Path('tests/stock-browser.cjs')
s=p.read_text(encoding='utf-8')
old="await input('计划数量').fill('10'); await input('实际入库数量').fill('8');"
new="await input('计划数量').fill('7'); await input('实际入库数量').fill('8');"
if old not in s:
 print('old not found; nearby:')
 i=s.find("fill('10')")
 print(repr(s[i-80:i+130]))
else:
 s=s.replace(old,new,1)
anchor="    await page.getByText('确认入库 · ¥20.00', { exact: true }).click();\n"
if anchor not in s:
 print('anchor not found')
else:
 s=s.replace(anchor, anchor+"    await page.getByText('实际入库超过计划', { exact: true }).waitFor();\n    await page.getByText('继续入库', { exact: true }).click();\n",1)
p.write_text(s,encoding='utf-8')
