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
});
