// main.js - Workflow × DSH Electron shell.
// Boots Workflow Core and the DSH web server as managed child processes,
// then opens one native window over the DSH web UI (which carries the
// Workflow plugin: sidebar menus, main-area pages, login gate).
// Quitting the app tears both children down.
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const CORE_PORT = Number(process.env.WFC_HTTPS_PORT || 8710);
const DSH_PORT = Number(process.env.DSH_WEB_PORT || 8333);
const IS_PACKAGED = app.isPackaged;
const ROOT = IS_PACKAGED
  ? path.join(process.resourcesPath)
  : path.join(__dirname, '..');

const coreDir = path.join(ROOT, 'workflow-core');
const dshPluginDir = path.join(ROOT, 'dsh-workflow', 'web', '@workflow', 'dsh-web');
const dshRunner = path.join(ROOT, 'dsh-workflow', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const dshHomeDir = path.join(app.getPath('userData'), 'dsh');
const dshProfileName = 'workflow-web';
const dshProfileDir = path.join(dshHomeDir, 'profiles', dshProfileName);
const coreDataDir = path.join(app.getPath('userData'), 'core-data');

const children = [];
let mainWindow = null;

function log(line) { console.log(`[dsh-desktop] ${line}`); }

function freePortProbe(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForPort(port, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await freePortProbe(port)) { log(`${label} ready on :${port}`); return true; }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label} did not become ready on :${port}`);
}

// The DSH profile must exist with our plugin installed and registered.
function ensureDshProfile() {
  fs.mkdirSync(dshProfileDir, { recursive: true });
  const pkgPath = path.join(dshProfileDir, 'package.json');
  const pluginTarget = path.join(dshProfileDir, 'node_modules', '@workflow', 'dsh-web');
  const patchPath = path.join(dshProfileDir, 'cordis.patch.yml');

  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { '@workflow/dsh-web': 'file:./node_modules/@workflow/dsh-web' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2));
    log('dsh profile created');
  }
  // Link our plugin into the profile's node_modules (junction-free copy for packaging).
  fs.mkdirSync(path.dirname(pluginTarget), { recursive: true });
  fs.cpSync(dshPluginDir, pluginTarget, { recursive: true, force: true });
  if (!fs.existsSync(patchPath)) {
    fs.writeFileSync(patchPath, '- insert:\n    - id: workflow-dsh-web\n      name: \'@workflow/dsh-web\'\n');
    log('dsh patch registered');
  }
}

function startCore() {
  const entry = path.join(coreDir, 'packages', 'core', 'src', 'index.js');
  const env = {
    ...process.env,
    WFC_DATA_DIR: coreDataDir,
    WFC_ALLOW_PLAIN_HTTP: '1',
    WFC_HTTPS_PORT: String(CORE_PORT),
    WFC_INTERNAL_PORT: String(CORE_PORT + 1),
    WFC_NODE_ID: process.env.WFC_NODE_ID || `node-${require('node:os').hostname().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'desktop'}`,
    WFC_CORS_ORIGINS: `http://127.0.0.1:${DSH_PORT},http://localhost:${DSH_PORT}`,
  };
  const child = spawn('node', [entry], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (d) => log(`[core] ${d.toString().trim()}`));
  child.stderr.on('data', (d) => log(`[core!] ${d.toString().trim()}`));
  children.push(child);
  return child;
}

function startDshWeb() {
  // The DSH CLI runs under the system node (it needs the profile's node_modules).
  const env = {
    ...process.env,
    DSH_HOME: dshHomeDir,
  };
  const child = spawn('node', [
    dshRunner,
    '--profile',
    dshProfileName,
    '--no-open',
    '--port',
    String(DSH_PORT),
  ], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (d) => log(`[dsh] ${d.toString().trim()}`));
  child.stderr.on('data', (d) => log(`[dsh!] ${d.toString().trim()}`));
  children.push(child);
  return child;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Workflow',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
	  mainWindow.loadURL(`http://127.0.0.1:${DSH_PORT}`);
	  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
	    log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
	  });
	  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
	    log(`[renderer] load failed ${errorCode} ${errorDescription} ${validatedURL}`);
	  });
	  mainWindow.webContents.on('render-process-gone', (_event, details) => {
	    log(`[renderer] process gone ${details.reason}${details.exitCode == null ? '' : ` exit=${details.exitCode}`}`);
	  });
	  mainWindow.webContents.on('unresponsive', () => log('[renderer] unresponsive'));
	  mainWindow.webContents.on('responsive', () => log('[renderer] responsive'));
	  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    ensureDshProfile();
    startCore();
    startDshWeb();
    await waitForPort(CORE_PORT, 'workflow-core');
    await waitForPort(DSH_PORT, 'dsh web');
    createWindow();
  } catch (error) {
    log(`boot failed: ${error.message}`);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('quit', () => {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
});
