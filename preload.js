const { contextBridge, ipcRenderer } = require('electron/renderer');

contextBridge.exposeInMainWorld('claude', {
  start: (request) => ipcRenderer.send('claude:start', request),
  cancel: (requestId) => ipcRenderer.send('claude:cancel', requestId),
  getDefaultDirectory: () => ipcRenderer.invoke('claude:get-default-directory'),
  pickDirectory: () => ipcRenderer.invoke('claude:pick-directory'),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('claude:event', listener);

    return () => ipcRenderer.removeListener('claude:event', listener);
  },
});

contextBridge.exposeInMainWorld('explorations', {
  list: () => ipcRenderer.invoke('explorations:list'),
  get: (id) => ipcRenderer.invoke('explorations:get', id),
  save: (exploration) => ipcRenderer.invoke('explorations:save', exploration),
});
