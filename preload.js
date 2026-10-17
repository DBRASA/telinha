const { contextBridge, ipcRenderer } = require('electron');

let audioListener = null;
ipcRenderer.on('audio-data', (_e, chunk) => audioListener?.(chunk));

contextBridge.exposeInMainWorld('telinha', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectSource: (id, audio) => ipcRenderer.invoke('select-source', id, audio),
  audioStart: (args) => ipcRenderer.invoke('audio-start', args),
  audioStop: () => ipcRenderer.invoke('audio-stop'),
  onAudioData: (fn) => { audioListener = fn; },
  radminStatus: () => ipcRenderer.invoke('radmin-status'),
  radminOpen: () => ipcRenderer.invoke('radmin-open'),
});
