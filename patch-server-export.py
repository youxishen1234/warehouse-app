from pathlib import Path
p=Path('backend/server.js')
s=p.read_text(encoding='utf-8')
old="""app.listen(PORT, '0.0.0.0', ()=>{
  const lanIP = getLanIP();
  console.log(`\\n  ============================================`);
  console.log(`  仓库出入库管理系统（无码版）已启动`);
  console.log(`  电脑本地: http://localhost:${PORT}`);
  console.log(`  手机访问: http://${lanIP}:${PORT}  （手机与电脑连同一WiFi）`);
  console.log(`  操作方式: 从下拉列表选择商品即可出入库`);
  console.log(`  ============================================\\n`);
});
"""
# Comments are mojibake in this checkout; locate by exact structural start/end instead.
start=s.find("app.listen(PORT, '0.0.0.0', ()=>{")
if start<0: raise SystemExit('listen block start not found')
end=s.find("});", start)
if end<0: raise SystemExit('listen block end not found')
end += 3
block=s[start:end]
replacement="if (require.main === module) {\n"+block+"\n}\n\nmodule.exports = app;"
p.write_text(s[:start]+replacement+s[end:],encoding='utf-8')
print('patched app export')
