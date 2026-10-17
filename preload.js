const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('telinha', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectSource: (id, audio) => ipcRenderer.invoke('select-source', id, audio),
});
