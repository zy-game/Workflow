// shell.test.mjs - source contracts for the desktop shell.
//
// The shell is thin on purpose: it must not become a second UI, and it must not
// hand the console a privileged surface. These checks run without launching
// Electron, so they guard the shape of the app rather than its pixels.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createConfigStore } = require('../lib/config.js');
const { createExecutor } = require('../lib/executor.js');

const root = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(root, '../main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, '../preload.js'), 'utf8');
const console_ = fs.readFileSync(path.join(root, '../../workflow-core/packages/core/src/console/app.js'), 'utf8');

test('the shell loads the server-hosted console instead of its own UI', () => {
  assert.match(main, /loadURL\(`\$\{SERVER_URL\}\/console`\)/);
  assert.match(main, /WORKFLOW_SERVER_URL/);
  // Packaged builds ship the Worker as a resource, so the base path differs.
  assert.match(main, /app\.isPackaged \? process\.resourcesPath/);
  // No local HTML to drift out of sync with the console.
  assert.ok(!fs.existsSync(path.join(root, '../index.html')), 'the shell must not ship its own page');
});

test('the preload exposes capabilities, not privileges', () => {
  const exposed = [...preload.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((match) => match[1]).sort();
  assert.deepEqual(exposed, ['executor', 'idleBucket', 'notify', 'platform', 'serverUrl']);
  // The worker token must never cross the bridge (comments aside).
  assert.ok(!/token/i.test(preload.replace(/\/\/.*$/gm, '')), 'the preload must not carry the worker token');
  assert.match(preload, /contextBridge\.exposeInMainWorld\('workflowDesktop'/);
  // The bridge must not carry files, processes, or credentials.
  for (const forbidden of ['fs', 'exec', 'spawn', 'credential', 'token', 'env']) {
    assert.ok(!exposed.includes(forbidden), `preload must not expose ${forbidden}`);
  }
});

test('the window is sandboxed and isolated', () => {
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
});

test('external links leave the shell', () => {
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /openExternal/);
  assert.match(main, /action: 'deny'/);
});

test('idle detection asks the OS, not the page', () => {
  assert.match(main, /powerMonitor\.getSystemIdleTime\(\)/);
  assert.match(main, /'active'/);
  assert.match(main, /'recent'/);
  assert.match(main, /'idle'/);
});

test('the console prefers the shell and falls back to the browser', () => {
  assert.match(console_, /window\.workflowDesktop/);
  assert.match(console_, /desktop\.idleBucket/);
  assert.match(console_, /localIdleBucket\(\)/);
  assert.match(console_, /desktop\.notify/);
  // Without the shell it must still work as an ordinary web page.
  assert.match(console_, /document\.visibilityState/);
  assert.match(console_, /document\.hasFocus\(\)/);
});

test('the worker token is sealed and never returned as plaintext', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-shell-config-'));
  const sealed = [];
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => { sealed.push(value); return Buffer.from(`sealed:${value}`); },
    decryptString: (buffer) => buffer.toString().replace(/^sealed:/, ''),
  };
  try {
    const store = createConfigStore({ dir, serverUrl: 'http://127.0.0.1:8710', safeStorage: fakeSafeStorage });
    store.setToken('wfc-secret-token');
    assert.equal(store.getToken(), 'wfc-secret-token');
    assert.equal(store.publicConfig().hasToken, true);
    assert.ok(!JSON.stringify(store.publicConfig()).includes('wfc-secret-token'), 'publicConfig must not leak the token');
    assert.ok(!fs.readFileSync(store.file, 'utf8').includes('wfc-secret-token'), 'the token must not sit in a readable file');
    store.setToken(null);
    assert.equal(store.getToken(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the executor supervises exactly one worker process', async () => {
  const entry = path.join(root, 'fixtures/stay-alive.cjs');
  const executor = createExecutor({ entry, log: () => {} });
  try {
    const started = executor.start({ serverUrl: 'http://127.0.0.1:8710', token: 'wfc-x' });
    assert.equal(started.running, true);
    assert.ok(started.pid, 'a started executor must have a pid');
    // Starting again must not spawn a second process.
    assert.equal(executor.start({ serverUrl: 'http://127.0.0.1:8710', token: 'wfc-x' }).pid, started.pid);
    assert.equal(executor.isRunning(), true);

    // The child must run on a real Node, not Electron's older bundled runtime.
    const source = fs.readFileSync(path.join(root, '../lib/executor.js'), 'utf8');
    assert.match(source, /WORKFLOW_NODE_BIN/);
    assert.ok(!/spawn\(process\.execPath/.test(source), 'the executor must not spawn the Electron binary');

    const stopped = executor.stop();
    assert.equal(stopped.running, false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(executor.isRunning(), false);
  } finally {
    executor.stop();
  }
});

test('a packaged build ships the worker it supervises', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, '../package.json'), 'utf8'));
  assert.deepEqual(pkg.build.win.target, ['nsis']);
  assert.equal(pkg.build.productName, 'Workflow');
  const shipped = pkg.build.extraResources.map((entry) => entry.to);
  assert.ok(shipped.includes('workflow-core/packages'), 'the worker source must ship with the shell');
  assert.ok(shipped.includes('workflow-core/node_modules'), 'the worker dependencies must ship too');
  assert.match(pkg.scripts.build, /electron-builder/);
});
