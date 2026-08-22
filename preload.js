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

contextBridge.exposeInMainWorld('workflows', {
  list: (taskId) => ipcRenderer.invoke('workflows:list', taskId),
  get: (taskId) => ipcRenderer.invoke('workflows:get', taskId),
  start: (taskId, sourcePath) =>
    ipcRenderer.invoke('workflows:start', taskId, sourcePath),
  resolve: (runId, key, value) =>
    ipcRenderer.invoke('workflows:resolve', runId, key, value),
  stop: (runId) => ipcRenderer.invoke('workflows:stop', runId),
  diff: (taskId) => ipcRenderer.invoke('workflows:diff', taskId),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('workflows:event', listener);
    return () => ipcRenderer.removeListener('workflows:event', listener);
  },
});
