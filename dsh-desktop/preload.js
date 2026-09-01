// preload.js - minimal bridge; the DSH web client needs no extra privileges.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('workflowDesktop', { platform: process.platform });
