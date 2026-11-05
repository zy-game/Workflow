const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('qmDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  setupAgent: (target) => ipcRenderer.invoke('agent:setup', target),
  installDshMcp: () => ipcRenderer.invoke('agent:install-dsh'),
  startWorker: () => ipcRenderer.invoke('agent:worker-start'),
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
})
