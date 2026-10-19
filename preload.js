const { contextBridge, ipcRenderer } = require('electron');

let audioListener = null;
ipcRenderer.on('audio-data', (_e, chunk) => audioListener?.(chunk));
let toggleLiveListener = null;
ipcRenderer.on('toggle-live', () => toggleLiveListener?.());

contextBridge.exposeInMainWorld('telinha', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectSource: (id, audio) => ipcRenderer.invoke('select-source', id, audio),
  audioStart: (args) => ipcRenderer.invoke('audio-start', args),
  audioStop: () => ipcRenderer.invoke('audio-stop'),
  onAudioData: (fn) => { audioListener = fn; },
  discordLogin: () => ipcRenderer.invoke('discord-login'),
  showWindow: () => ipcRenderer.invoke('show-window'),
  appName: (target) => ipcRenderer.invoke('app-name', target),
  onToggleLive: (fn) => { toggleLiveListener = fn; },
  setShortcut: (accel) => ipcRenderer.invoke('set-shortcut', accel),
});
