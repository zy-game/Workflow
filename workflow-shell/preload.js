// preload.js - the only surface the shell exposes to the console.
//
// Everything here is a capability a browser cannot provide. Nothing about the
// user's files, credentials, or the host process is reachable from the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workflowDesktop', {
  platform: process.platform,
  // OS-level idle, so "visible but untouched" is not mistaken for presence.
  idleBucket: () => ipcRenderer.invoke('workflow:idle-bucket'),
  // Native notifications survive the window being closed or minimised.
  notify: (payload) => ipcRenderer.invoke('workflow:notify', payload),
  serverUrl: () => ipcRenderer.invoke('workflow:server-url'),
  // Local settings, used by the local settings window: the executor CLI, the
  // server address, and the executor's own start/stop. The worker token never
  // crosses this bridge in either direction.
  settings: {
    // Settings belong to the machine, not the server, so the console only
    // offers a way to open the local window.
    open: () => ipcRenderer.invoke('workflow:open-settings'),
    get: () => ipcRenderer.invoke('workflow:settings-get'),
    save: (patch) => ipcRenderer.invoke('workflow:settings-save', patch),
    catalog: () => ipcRenderer.invoke('workflow:cli-catalog'),
    installCli: (id) => ipcRenderer.invoke('workflow:install-cli', id),
  },
  // The local executor: status only.
  executor: {
    status: () => ipcRenderer.invoke('workflow:executor-status'),
    start: () => ipcRenderer.invoke('workflow:executor-start'),
    stop: () => ipcRenderer.invoke('workflow:executor-stop'),
  },
});
