const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const directory = path.resolve(process.env.DOWNLOAD_PREVIEW_DIR || 'release/download');
const port = Number(process.env.DOWNLOAD_PREVIEW_PORT || 4173);
const ipa = process.env.DOWNLOAD_PREVIEW_IPA;
const routes = {
  '/download': ['index.html', 'text/html; charset=utf-8'],
  '/download/': ['index.html', 'text/html; charset=utf-8'],
  '/download/ipa.json': ['ipa.json', 'application/json'],
  '/download/app-icon.png': ['app-icon.png', 'image/png'],
};

http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
  const url = new URL(request.url, 'http://localhost');
  let route = routes[url.pathname];
  let filename;
  if (url.pathname === '/shuguang.ipa' && ipa) {
    route = [null, 'application/octet-stream'];
    filename = path.resolve(ipa);
    response.setHeader('Content-Disposition', 'attachment; filename="shuguang.ipa"');
  } else if (route) {
    filename = path.join(directory, route[0]);
  }
  if (!filename || !fs.existsSync(filename)) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', route[1]);
  response.setHeader('Content-Length', fs.statSync(filename).size);
  response.setHeader('Cache-Control', 'no-cache');
  if (request.method === 'HEAD') { response.end(); return; }
  fs.createReadStream(filename).on('error', () => response.destroy()).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`Download preview: http://127.0.0.1:${port}/download`));
