const { app, BrowserWindow, shell, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { installLocalPrintBridge } = require('./print-bridge.cjs');
const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'nonce-sg-bootstrap'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://youxishen.online http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*; font-src 'self' data:; connect-src 'self' capacitor://localhost https://youxishen.online http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*; worker-src 'self' blob:;";
let mainWindow;
function applicationEntry() {
  const built = path.join(__dirname, '..', 'dist', 'index.html');
  return fs.existsSync(built) ? built : path.join(__dirname, '..', 'www', 'index.html');
}
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true
    }
  });
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders, 'Content-Security-Policy': [CONTENT_SECURITY_POLICY] };
    callback({ responseHeaders });
  });
  win.loadFile(applicationEntry());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { if (mainWindow === win) mainWindow = undefined; });
  mainWindow = win;
  return win;
}
app.whenReady().then(() => {
  installLocalPrintBridge({ ipcMain, BrowserWindow, session, getWindow: () => mainWindow });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
