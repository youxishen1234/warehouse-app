const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('warehouseLocalPrint', Object.freeze({
  version: 1,
  listPrinters: () => ipcRenderer.invoke('warehouse-local-print:list'),
  print: request => ipcRenderer.invoke('warehouse-local-print:send', request)
}));
