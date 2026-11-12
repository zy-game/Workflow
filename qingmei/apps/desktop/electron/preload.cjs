const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('qmDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  probeServer: (input) => ipcRenderer.invoke('settings:probe', input),
  writeWorkerConfig: () => ipcRenderer.invoke('agent:worker-config'),
  startWorker: () => ipcRenderer.invoke('agent:worker-start'),
  getDeviceId: () => ipcRenderer.invoke('device:id'),
  popupMenu: () => ipcRenderer.invoke('menu:popup'),
  quit: () => ipcRenderer.send('app:quit'),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('window:ignore-mouse', Boolean(ignore)),
  moveBy: (dx, dy) => ipcRenderer.send('window:move-by', { dx, dy }),
  notify: (payload) => ipcRenderer.invoke('notify:show', payload),
  hide: () => ipcRenderer.send('window:hide'),
  onOpenSettings: (callback) => {
    ipcRenderer.on('open-settings', () => callback())
  },
  onReconnect: (callback) => {
    ipcRenderer.on('reconnect', () => callback())
  },
  onPetAction: (callback) => {
    ipcRenderer.on('pet-action', (_event, action) => callback(action))
  },
  onShowUsage: (callback) => {
    ipcRenderer.on('show-usage', () => callback())
  },
})


