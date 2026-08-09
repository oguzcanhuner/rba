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
