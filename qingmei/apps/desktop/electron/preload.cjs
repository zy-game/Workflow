const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('qmDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  popupMenu: () => ipcRenderer.invoke('menu:popup'),
  quit: () => ipcRenderer.send('app:quit'),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('window:ignore-mouse', Boolean(ignore)),
  moveBy: (dx, dy) => ipcRenderer.send('window:move-by', { dx, dy }),
  hide: () => ipcRenderer.send('window:hide'),
  onOpenSettings: (callback) => {
    ipcRenderer.on('open-settings', () => callback())
  },
  onReconnect: (callback) => {
    ipcRenderer.on('reconnect', () => callback())
  },
})
