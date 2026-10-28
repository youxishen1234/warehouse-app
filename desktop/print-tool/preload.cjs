const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopPrint', {
  printers: () => ipcRenderer.invoke('print-tool:printers'),
  preview: data => ipcRenderer.invoke('print-tool:preview', data),
  pdf: data => ipcRenderer.invoke('print-tool:pdf', data),
  print: data => ipcRenderer.invoke('print-tool:print', data),
});
