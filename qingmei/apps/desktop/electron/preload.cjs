const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('qmDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  popupMenu: () => ipcRenderer.invoke('menu:popup'),
  quit: () => ipcRenderer.send('app:quit'),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('window:ignore-mouse', Boolean(ignore)),
  onOpenSettings: (callback) => {
    ipcRenderer.on('open-settings', () => callback())
  },
  onReconnect: (callback) => {
    ipcRenderer.on('reconnect', () => callback())
  },
})
