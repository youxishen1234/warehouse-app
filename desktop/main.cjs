const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'nonce-sg-bootstrap'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://youxishen.online http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*; font-src 'self' data:; connect-src 'self' capacitor://localhost https://youxishen.online http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*; worker-src 'self' blob:;";
function createWindow() {
  const win = new BrowserWindow({ width: 1280, height: 820, minWidth: 1024, minHeight: 680, autoHideMenuBar: true, backgroundColor: '#f5f7fb', webPreferences: { contextIsolation: true, sandbox: true } });
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders, 'Content-Security-Policy': [CONTENT_SECURITY_POLICY] };
    callback({ responseHeaders });
  });
  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}
app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
