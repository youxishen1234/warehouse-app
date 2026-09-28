from pathlib import Path
p=Path('backend/team.js')
s=p.read_text(encoding='utf-8')
old="  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Warehouse-Revision', String(db.revision())); next(); });"
new="""  router.use((req, res, next) => {
    const requestId = req.get('X-Request-Id') || crypto.randomUUID();
    res.set({
      'Cache-Control': 'no-store',
      'X-Warehouse-Revision': String(db.revision()),
      'X-Request-Id': requestId,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    next();
  });"""
if old not in s: raise SystemExit('team middleware not found')
p.write_text(s.replace(old,new,1),encoding='utf-8')

p=Path('backend/server.js')
s=p.read_text(encoding='utf-8')
s=s.replace("const PORT = Number(process.env.PORT || 4000);", "const PORT = Number(process.env.PORT || 4000);\n\napp.disable('x-powered-by');", 1)
needle="app.use((req, res, next) => {\n  res.setHeader('Access-Control-Allow-Origin', '*');"
replacement="""app.use((req, res, next) => {
  const requestId = req.get('X-Request-Id') || require('crypto').randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Access-Control-Allow-Origin', '*');"""
if needle not in s: raise SystemExit('server middleware not found')
p.write_text(s.replace(needle,replacement,1),encoding='utf-8')

p=Path('backend/team.test.cjs')
s=p.read_text(encoding='utf-8')
s=s.replace("return {status:r.status,body:await r.json(),revision:r.headers.get('x-warehouse-revision')};", "return {status:r.status,body:await r.json(),revision:r.headers.get('x-warehouse-revision'),requestId:r.headers.get('x-request-id'),security:{nosniff:r.headers.get('x-content-type-options'),frame:r.headers.get('x-frame-options'),referrer:r.headers.get('referrer-policy')}};")
s=s.replace("  try {\n    assert.equal((await call('/products')).status,401);", "  try {\n    const health = await call('/health');\n    assert.equal(health.status, 200);\n    assert.match(health.requestId || '', /^[0-9a-f-]{36}$/);\n    assert.equal(health.security.nosniff, 'nosniff');\n    assert.equal(health.security.frame, 'DENY');\n    assert.equal(health.security.referrer, 'no-referrer');\n    assert.equal((await call('/products')).status,401);")
p.write_text(s,encoding='utf-8')
print('patched security headers')
