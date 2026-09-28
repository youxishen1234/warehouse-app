// Local-only review: original reference video next to the actual built app.
// API responses are mocked in this preview, so navigating cannot write business data.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'dist');
const video = path.resolve(process.argv[2] || 'release/glass-reference-dark.mp4');
const port = Number(process.env.GLASS_PREVIEW_PORT || 4186);
const mock = `<script>
const originalFetch = window.fetch.bind(window);
window.fetch = (input, options) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.includes('/api/')) return originalFetch(input, options);
  let data = [];
  if (url.includes('/auth/guest')) data = { token: 'local-preview', user: { id: '1', username: 'preview', role: 'viewer' } };
  if (url.includes('/stats')) data = { todayIn: 0, todayOut: 0, totalProducts: 0, totalStock: 0, lowStock: 0, totalValue: 0 };
  if (url.includes('/sync')) data = { revision: 1 };
  return Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
};
</script>`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>底栏 · 视频对照</title><style>
*{box-sizing:border-box}body{margin:0;background:#f1f2f4;color:#202024;font-family:system-ui,sans-serif}main{max-width:1040px;margin:auto;padding:24px}h1{font-size:23px;margin:0 0 8px}p{font-size:13px;color:#65656e;line-height:1.7;margin:0 0 18px}.columns{display:flex;align-items:flex-start;justify-content:center;gap:32px;flex-wrap:wrap}.column{width:440px;max-width:100%}h2{font-size:14px;margin:14px 0}video,iframe{display:block;width:440px;max-width:100%;height:956px;background:white;border:1px solid #d7d7dd;border-radius:22px}video{object-fit:contain;background:black}button{border:1px solid #d2d2d8;border-radius:8px;padding:8px 12px;background:white;color:#27272d;cursor:pointer;margin:12px 6px 0 0}output{font-size:12px;color:#65656e}a{color:#24a6f8}
</style><main><h1>底栏 · 视频对照</h1><p>左侧是参考视频的浏览器转码，右侧是当前构建，可直接拖动底栏胶囊。网页中的数据为本地演示数据。<br>此页验证网页实现；iOS 26 原生底栏仍需在 iPhone 上对照验收。</p>
<div class="columns"><section class="column"><h2>参考视频</h2><video id="reference" src="/reference.mp4" muted loop playsinline autoplay></video><input id="seek" aria-label="视频进度" type="range" min="0" max="8.64" step="0.01" value="0" style="width:100%"><button id="play">暂停</button><button id="speed">0.5 倍速</button><button id="restart">从头播放</button></section>
<section class="column"><h2>当前网页实现</h2><iframe id="app" title="仓库应用底栏预览" src="/app/"></iframe><button id="contrast">显示折射测试背景</button><button id="reload">重新加载</button><output id="status"></output></section></div></main><script>
const video = document.querySelector('video'), frame = document.querySelector('iframe');
video.onloadedmetadata = () => { document.querySelector('#seek').max = video.duration; };
document.querySelector('#play').onclick = () => { if (video.paused) video.play(); else video.pause(); };
video.onpause = () => { document.querySelector('#play').textContent = '播放'; };
video.onplay = () => { document.querySelector('#play').textContent = '暂停'; };
video.ontimeupdate = () => { document.querySelector('#seek').value = video.currentTime; };
document.querySelector('#seek').oninput = event => { video.pause(); video.currentTime = Number(event.target.value); };
document.querySelector('#speed').onclick = event => { video.playbackRate = video.playbackRate === 1 ? .5 : 1; event.target.textContent = video.playbackRate === 1 ? '0.5 倍速' : '正常速度'; };
document.querySelector('#restart').onclick = () => { video.currentTime = 0; video.play(); };
document.querySelector('#reload').onclick = () => { frame.src = '/app/'; };
document.querySelector('#contrast').onclick = event => {
  const doc = frame.contentDocument, existing = doc.querySelector('#glass-review-backdrop');
  if (existing) { existing.remove(); event.target.textContent = '显示折射测试背景'; return; }
  const backdrop = doc.createElement('div'); backdrop.id = 'glass-review-backdrop';
  backdrop.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:170px;z-index:800;pointer-events:none;background:repeating-linear-gradient(100deg,transparent 0 24px,rgba(255,255,255,.9) 24px 31px,transparent 31px 50px),linear-gradient(115deg,#138de0,#392184 28%,#f5f5ef 50%,#df2346 80%,#ed8d39)';
  doc.body.appendChild(backdrop); event.target.textContent = '恢复页面背景';
};
</script></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
  const isVideo = url.pathname === '/reference.mp4';
  let filename;
  if (isVideo) filename = video;
  else {
    if (!url.pathname.startsWith('/app/')) return res.writeHead(404).end();
    filename = path.resolve(root, '.' + decodeURIComponent(url.pathname.slice(4) === '/' ? '/index.html' : url.pathname.slice(4)));
    if (!filename.startsWith(root + path.sep)) return res.writeHead(403).end();
  }
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) return res.writeHead(404).end();
  if (filename === path.join(root, 'index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(filename, 'utf8').replace('<head>', '<head>' + mock));
  }
  const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4' };
  const headers = { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  const size = fs.statSync(filename).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (isVideo && range) {
    const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
    if (start >= size || end < start) return res.writeHead(416, { 'Content-Range': 'bytes */' + size }).end();
    res.writeHead(206, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': end - start + 1 });
    return fs.createReadStream(filename, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  fs.createReadStream(filename).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log('Glass review: http://127.0.0.1:' + port));
