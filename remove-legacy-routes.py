from pathlib import Path
p=Path('backend/server.js')
s=p.read_text(encoding='utf-8')
start=s.find('const ok = (res,d)=>res.json({success:true,data:d});')
end=s.find('function getLanIP() {')
print(start,end)
if start<0 or end<0 or end<=start: raise SystemExit('legacy route block markers not found')
s=s[:start]+s[end:]
p.write_text(s,encoding='utf-8')
