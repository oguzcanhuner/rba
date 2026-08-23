const { contextBridge, ipcRenderer } = require('electron/renderer');

contextBridge.exposeInMainWorld('claude', {
  start: (request) => ipcRenderer.send('claude:start', request),
  cancel: (requestId, goalId) =>
    ipcRenderer.send('claude:cancel', requestId, goalId),
  getDefaultDirectory: () => ipcRenderer.invoke('claude:get-default-directory'),
  pickDirectory: () => ipcRenderer.invoke('claude:pick-directory'),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('claude:event', listener);

    return () => ipcRenderer.removeListener('claude:event', listener);
  },
});

contextBridge.exposeInMainWorld('goals', {
  list: () => ipcRenderer.invoke('goals:list'),
  get: (id) => ipcRenderer.invoke('goals:get', id),
  save: (goal) => ipcRenderer.invoke('goals:save', goal),
  commitTasks: (goalId) => ipcRenderer.invoke('goals:commit-tasks', goalId),
});

contextBridge.exposeInMainWorld('tasks', {
  list: () => ipcRenderer.invoke('tasks:list'),
});

contextBridge.exposeInMainWorld('workers', {
  get: (taskId) => ipcRenderer.invoke('workers:get', taskId),
  start: (taskId) => ipcRenderer.invoke('workers:start', taskId),
  stop: (taskId) => ipcRenderer.invoke('workers:stop', taskId),
  send: (taskId, prompt) => ipcRenderer.invoke('workers:send', taskId, prompt),
  diff: (taskId) => ipcRenderer.invoke('workers:diff', taskId),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('workers:event', listener);

    return () => ipcRenderer.removeListener('workers:event', listener);
  },
});
