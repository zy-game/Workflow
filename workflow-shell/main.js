// main.js - the Workflow desktop shell.
//
// Deliberately thin: it loads the server-hosted console so there is exactly one
// UI, and adds only what a browser cannot provide - OS-level idle detection,
// native notifications, and a process that keeps running so the assistant can
// reach the user on this machine.
const path = require('node:path');
const { app, BrowserWindow, Notification, ipcMain, powerMonitor, shell } = require('electron');

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
  ipcMain.handle('workflow:idle-bucket', () => idleBucket());
  ipcMain.handle('workflow:notify', (_event, payload) => {
    const title = String(payload?.title ?? 'Workflow').slice(0, 120);
    const body = String(payload?.body ?? '').slice(0, 500);
    if (!Notification.isSupported()) return false;
    new Notification({ title, body, silent: false }).show();
    return true;
  });
  ipcMain.handle('workflow:server-url', () => SERVER_URL);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // The shell exists to stay reachable, so it keeps running on every platform.
  if (process.platform === 'darwin') return;
});
