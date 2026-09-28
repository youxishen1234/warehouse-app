from pathlib import Path
p=Path('backend/server.js')
s=p.read_text(encoding='utf-8')
marker="app.listen(PORT, '0.0.0.0'"
idx=s.find(marker)
insert="""// 统一处理请求体解析错误，避免 Express 默认返回 HTML 或堆栈。
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large' || err?.status === 413) return res.status(413).json({ success: false, message: '请求内容过大，请减少提交内容后重试' });
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) return res.status(400).json({ success: false, message: '请求数据格式错误，请检查 JSON 内容' });
  if (req.path.startsWith('/api')) return res.status(err?.status || 500).json({ success: false, message: err?.status ? (err.message || '请求失败') : '服务器暂时无法处理请求' });
  next(err);
});

"""
if idx<0: raise SystemExit('listen not found')
p.write_text(s[:idx]+insert+s[idx:],encoding='utf-8')
