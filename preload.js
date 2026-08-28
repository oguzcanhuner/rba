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
  markRead: (id) => ipcRenderer.invoke('goals:mark-read', id),
  markUnread: (id) => ipcRenderer.invoke('goals:mark-unread', id),
  rename: (id, title) => ipcRenderer.invoke('goals:rename', id, title),
  complete: (id) => ipcRenderer.invoke('goals:complete', id),
  reopen: (id) => ipcRenderer.invoke('goals:reopen', id),
  delete: (id) => ipcRenderer.invoke('goals:delete', id),
  commitTasks: (goalId) => ipcRenderer.invoke('goals:commit-tasks', goalId),
});

contextBridge.exposeInMainWorld('tasks', {
  list: () => ipcRenderer.invoke('tasks:list'),
  delete: (taskId) => ipcRenderer.invoke('tasks:delete', taskId),
});

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (partial) => ipcRenderer.invoke('settings:set', partial),
});

contextBridge.exposeInMainWorld('workers', {
  get: (taskId) => ipcRenderer.invoke('workers:get', taskId),
  start: (taskId) => ipcRenderer.invoke('workers:start', taskId),
  stop: (taskId) => ipcRenderer.invoke('workers:stop', taskId),
  send: (taskId, prompt) => ipcRenderer.invoke('workers:send', taskId, prompt),
  diff: (taskId) => ipcRenderer.invoke('workers:diff', taskId),
  complete: (taskId) => ipcRenderer.invoke('workers:complete', taskId),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('workers:event', listener);

    return () => ipcRenderer.removeListener('workers:event', listener);
  },
});

contextBridge.exposeInMainWorld('workflows', {
  list: () => ipcRenderer.invoke('workflows:list'),
  get: (id) => ipcRenderer.invoke('workflows:get', id),
  getRun: (runId) => ipcRenderer.invoke('workflows:run-get', runId),
  start: (id, options) => ipcRenderer.invoke('workflows:start', id, options),
  stop: (runId) => ipcRenderer.invoke('workflows:stop', runId),
  delete: (id) => ipcRenderer.invoke('workflows:delete', id),
  save: (workflow) => ipcRenderer.invoke('workflows:save', workflow),
  pickDirectory: () => ipcRenderer.invoke('workflows:pick-directory'),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('workflows:event', listener);

    return () => ipcRenderer.removeListener('workflows:event', listener);
  },
});
