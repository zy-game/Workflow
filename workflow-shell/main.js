// main.js - the Workflow desktop shell.
//
// Deliberately thin: it loads the server-hosted console so there is exactly one
// UI, and adds only what a browser cannot provide - OS-level idle detection,
// native notifications, and a process that keeps running so the assistant can
// reach the user on this machine.
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, Notification, ipcMain, powerMonitor, safeStorage, shell } = require('electron');
const { createConfigStore } = require('./lib/config.js');
const { createExecutor } = require('./lib/executor.js');

const SERVER_URL = (process.env.WORKFLOW_SERVER_URL || 'http://127.0.0.1:8710').replace(/\/+$/, '');
const IDLE_ACTIVE_SECONDS = 60;
const IDLE_RECENT_SECONDS = 300;

// The same buckets the console reports, but measured by the OS instead of the
// page: a window that is visible but untouched is not presence.
function idleBucket() {
  if (!powerMonitor) return 'unknown';
  const seconds = powerMonitor.getSystemIdleTime();
  if (seconds < IDLE_ACTIVE_SECONDS) return 'active';
  if (seconds < IDLE_RECENT_SECONDS) return 'recent';
  return 'idle';
}

let mainWindow = null;
let configStore = null;
let executor = null;

// The local Agent Runtime the shell supervises. It is the Worker, because the
// Worker already owns the backend contract, leases and result reporting.
const WORKER_ENTRY = process.env.WORKFLOW_WORKER_ENTRY
  || path.join(__dirname, '..', 'workflow-core', 'packages', 'worker', 'src', 'index.js');
// The token is issued by Core for a specific subject, so the shell tells the
// user which worker id to request instead of inventing one silently.
const DEFAULT_WORKER_ID = `worker-${os.hostname()}`;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    title: 'Workflow',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The console is ordinary web code; it needs no privileged surface.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`${SERVER_URL}/console`);
  // A blank window is the worst failure mode, so the shell reports what the
  // renderer says instead of leaving the user with a black rectangle.
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[renderer] load failed ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] process gone ${details.reason}`);
  });
  // External links belong in the user's browser, not inside the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  configStore = createConfigStore({
    dir: app.getPath('userData'), serverUrl: SERVER_URL, safeStorage, log: console.log,
  });
  // A token provisioned out of band is sealed into the OS credential store; it
  // never travels through the page. An explicit environment value wins, so
  // re-provisioning a machine does not silently keep the old credential.
  if (process.env.WORKFLOW_WORKER_TOKEN) {
    configStore.setToken(process.env.WORKFLOW_WORKER_TOKEN);
  }
  executor = createExecutor({ entry: WORKER_ENTRY, log: console.log });

  ipcMain.handle('workflow:idle-bucket', () => idleBucket());
  ipcMain.handle('workflow:notify', (_event, payload) => {
    const title = String(payload?.title ?? 'Workflow').slice(0, 120);
    const body = String(payload?.body ?? '').slice(0, 500);
    if (!Notification.isSupported()) return false;
    new Notification({ title, body, silent: false }).show();
    return true;
  });
  ipcMain.handle('workflow:server-url', () => SERVER_URL);
  ipcMain.handle('workflow:executor-status', () => ({
    ...executor.snapshot(),
    configured: Boolean(configStore.getToken()),
    workerId: configStore.publicConfig().workerId || DEFAULT_WORKER_ID,
    backendCommand: configStore.publicConfig().backendCommand,
  }));
  ipcMain.handle('workflow:executor-start', () => {
    const config = configStore.read();
    return executor.start({
      serverUrl: config.serverUrl || SERVER_URL,
      token: configStore.getToken(),
      workerId: config.workerId || DEFAULT_WORKER_ID,
      backendCommand: config.backendCommand,
      backendArgs: config.backendArgs,
    });
  });
  ipcMain.handle('workflow:executor-stop', () => executor.stop());
  // A provisioned token makes this machine an executor node without further
  // action: the point of the shell is to be reachable.
  if (configStore.getToken()) {
    const config = configStore.read();
    executor.start({
      serverUrl: config.serverUrl || SERVER_URL,
      token: configStore.getToken(),
      workerId: config.workerId || DEFAULT_WORKER_ID,
      backendCommand: config.backendCommand,
      backendArgs: config.backendArgs,
    });
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { executor?.stop(); });

app.on('window-all-closed', () => {
  // The shell exists to stay reachable, so it keeps running on every platform.
  if (process.platform === 'darwin') return;
});
