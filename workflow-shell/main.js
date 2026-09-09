// main.js - the Workflow desktop shell.
//
// Deliberately thin: it loads the server-hosted console so there is exactly one
// UI, and adds only what a browser cannot provide - OS-level idle detection,
// native notifications, and a process that keeps running so the assistant can
// reach the user on this machine.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, powerMonitor, safeStorage, shell } = require('electron');
const { createConfigStore } = require('./lib/config.js');
const { createExecutor } = require('./lib/executor.js');

// The server this shell talks to. Override with WORKFLOW_SERVER_URL; the
// default is the deployment this machine's worker already points at.
const SERVER_URL = (process.env.WORKFLOW_SERVER_URL || 'https://139.155.78.241:8710').replace(/\/+$/, '');
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

// A blank window explains nothing. If the console cannot load, say why and
// what to change - the server URL is the one thing the user can act on.
function fallbackHtml(url, description) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>Workflow</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e7e9ee;
font-family:system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;line-height:1.6}
.card{max-width:520px;padding:32px;background:#14171e;border:1px solid #262b35;border-radius:8px}
h1{font-size:16px;margin:0 0 12px}p{margin:0 0 12px;color:#9aa1ad;font-size:14px}
code{font-family:ui-monospace,Consolas,monospace;color:#6c8cff;word-break:break-all}
.hint{color:#6b7280;font-size:13px}</style></head><body><div class="card">
<h1>连不上 Workflow 服务器</h1>
<p>当前配置：<code>${url}</code></p>
<p>${description}</p>
<p class="hint">用环境变量 <code>WORKFLOW_SERVER_URL</code> 指定服务器地址后重新启动，例如<br>
<code>WORKFLOW_SERVER_URL=https://139.155.78.241:8710</code></p>
</div></body></html>`;
}
let configStore = null;
let executor = null;
let settingsWindow = null;
let tray = null;

// One place reads the config and starts the executor, so the settings window,
// the tray and startup all launch it identically.
function startExecutor() {
  const config = configStore.read();
  return executor.start({
    serverUrl: config.serverUrl || SERVER_URL,
    token: configStore.getToken(),
    workerId: config.workerId || DEFAULT_WORKER_ID,
    backendCommand: config.backendCommand,
    backendArgs: config.backendArgs,
  });
}

// Local settings live on this machine, so they are a local page rather than a
// console route: choosing a CLI executable means reading this machine's disk,
// which a server-hosted page must never be able to do.
function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.show(); settingsWindow.focus(); return settingsWindow; }
  settingsWindow = new BrowserWindow({
    width: 640,
    height: 760,
    title: 'Workflow 本机设置',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
  return settingsWindow;
}

// A background app needs a way back in and a way out; the console window alone
// cannot offer either once it is closed.
function trayIcon() {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const core = x > 4 && x < 11 && y > 4 && y < 11;
      buffer[offset] = core ? 255 : 150;      // blue
      buffer[offset + 1] = core ? 140 : 90;   // green
      buffer[offset + 2] = core ? 108 : 60;   // red
      buffer[offset + 3] = 255;               // alpha
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Workflow');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '本机设置…', click: () => createSettingsWindow() },
    { label: '打开控制台', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
    { type: 'separator' },
    { label: '退出 Workflow', click: () => { app.quit(); } },
  ]));
  tray.on('click', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
  return tray;
}

// The local Agent Runtime the shell supervises. It is the Worker, because the
// Worker already owns the backend contract, leases and result reporting.
// In development the Worker lives next to the shell in the repository; in a
// packaged build it is shipped as a resource, so the base directory differs.
const WORKER_BASE = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const WORKER_ENTRY = process.env.WORKFLOW_WORKER_ENTRY
  || path.join(WORKER_BASE, 'workflow-core', 'packages', 'worker', 'src', 'index.js');
// The token is issued by Core for a specific subject, so the shell tells the
// user which worker id to request instead of inventing one silently.
const DEFAULT_WORKER_ID = `worker-${os.hostname()}`;

// The execution engines the client can set up by itself. Each entry is a CLI the
// Worker's bridges already know how to drive, so choosing one here fills in the
// command, the bridge and the flags instead of asking for a path and an order.
const CLI_CATALOG = [
  {
    id: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex，经 codex exec --json 驱动。',
    package: '@openai/codex',
    bridge: 'codex-bridge.mjs',
    params: [{ flag: '--model', label: '模型', placeholder: 'gpt-5-codex' }],
  },
  {
    id: 'omp',
    label: 'OMP（oh-my-pi）',
    description: 'oh-my-pi，经 omp -p --mode json 驱动。',
    package: '@oh-my-pi/pi-coding-agent',
    bridge: 'omp-json-bridge.mjs',
    params: [
      { flag: '--model', label: '模型', placeholder: 'deepseek/deepseek-v4-flash-vision-exp' },
      { flag: '--profile', label: 'profile', placeholder: 'wfc-worker' },
    ],
  },
];

function bridgePath(name) {
  return path.join(WORKER_BASE, 'workflow-core', 'packages', 'worker', 'bin', name);
}

// "Installed" means present in the npm global tree the bridges look in, so the
// status shown here matches what the bridge will actually find.
function cliCatalog() {
  const globalRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules');
  return CLI_CATALOG.map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description,
    package: entry.package,
    params: entry.params,
    installed: fs.existsSync(path.join(globalRoot, ...entry.package.split('/'))),
    bridgePath: bridgePath(entry.bridge),
  }));
}

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
    // Ignore the fallback page itself, or this would reload forever.
    if (String(validatedURL).startsWith('data:')) return;
    mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fallbackHtml(validatedURL, `${errorCode} ${errorDescription}`))}`);
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

// Windows hides new tray icons in the overflow, so the discoverable way back
// into a running instance is to launch it again: the second launch hands over
// to the first one and asks for the settings window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) mainWindow.show(); else createWindow();
    createSettingsWindow();
  });
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  // The console carries its own navigation; the default Electron menu is noise.
  Menu.setApplicationMenu(null);
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
  ipcMain.handle('workflow:executor-start', () => startExecutor());
  ipcMain.handle('workflow:executor-stop', () => executor.stop());

  // Local settings. The token is deliberately absent: the window learns only
  // whether one exists.
  ipcMain.handle('workflow:settings-get', () => {
    const publicConfig = configStore.publicConfig();
    return {
      ...publicConfig,
      workerId: publicConfig.workerId || DEFAULT_WORKER_ID,
      executor: { ...executor.snapshot(), configured: Boolean(publicConfig.hasToken) },
    };
  });
  ipcMain.handle('workflow:settings-save', (_event, patch) => {
    const next = {};
    if (typeof patch?.serverUrl === 'string' && patch.serverUrl.trim()) next.serverUrl = patch.serverUrl.trim().replace(/\/+$/, '');
    if (typeof patch?.workerId === 'string' && patch.workerId.trim()) next.workerId = patch.workerId.trim();
    next.backendArgs = Array.isArray(patch?.backendArgs) ? patch.backendArgs.map(String).filter(Boolean) : [];
    // The command is always the Node runtime that runs the bridge; the window
    // never has to know it, and a hand-typed path cannot break it.
    next.backendCommand = next.backendArgs.length ? (process.env.WORKFLOW_NODE_BIN || 'node') : null;
    configStore.write(next);
    // A running executor would otherwise keep the engine it started with.
    const restarted = executor.isRunning();
    if (restarted) { executor.stop(); startExecutor(); }
    return { ok: true, restarted };
  });
  ipcMain.handle('workflow:cli-catalog', () => cliCatalog());
  // One-click install of a catalog entry. The output is returned rather than
  // streamed so the window can show the tail in one place.
  ipcMain.handle('workflow:install-cli', async (_event, id) => {
    const entry = CLI_CATALOG.find((item) => item.id === id);
    if (!entry) throw new Error(`unknown cli: ${id}`);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return await new Promise((resolve) => {
      execFile(npm, ['install', '-g', entry.package], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ ok: !error, output: String(error ? (stderr || error.message) : stdout).slice(-4000) });
      });
    });
  });
  createTray();
  // A provisioned token makes this machine an executor node without further
  // action: the point of the shell is to be reachable.
  if (configStore.getToken()) startExecutor();
  createWindow();
  // Without an engine the executor cannot claim anything, so say so up front.
  if (!configStore.read().backendCommand) createSettingsWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { executor?.stop(); });

app.on('window-all-closed', () => {
  // The shell exists to stay reachable, so it keeps running on every platform.
  if (process.platform === 'darwin') return;
});
