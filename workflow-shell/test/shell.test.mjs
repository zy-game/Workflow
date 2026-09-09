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
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createConfigStore } = require('../lib/config.js');
const { createExecutor } = require('../lib/executor.js');

const root = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(root, '../main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, '../preload.js'), 'utf8');
const console_ = fs.readFileSync(path.join(root, '../../workflow-core/packages/core/src/console/app.js'), 'utf8');

test('the console stays the main surface and local settings stay local', () => {
  assert.match(main, /loadURL\(`\$\{SERVER_URL\}\/console`\)/);
  assert.match(main, /WORKFLOW_SERVER_URL/);
  // Packaged builds ship the Worker as a resource, so the base path differs.
  assert.match(main, /app\.isPackaged \? process\.resourcesPath/);
  // The default target is the deployment this machine's worker points at.
  assert.match(main, /WORKFLOW_SERVER_URL \|\| 'https:\/\/139\.155\.78\.241:8710'/);
  // The shell must not ship a second console.
  assert.ok(!fs.existsSync(path.join(root, '../index.html')), 'the shell must not ship its own console page');
  // The local settings page exists because choosing and configuring an engine
  // is something a server-hosted page must never be able to do.
  const settings = fs.readFileSync(path.join(root, '../settings.html'), 'utf8');
  assert.match(settings, /id="catalog"/, 'the settings page must offer the CLI catalog');
  assert.match(settings, /data-install=/, 'a catalog entry must be installable');
  assert.match(settings, /data-use=/, 'a catalog entry must be selectable');
  assert.match(settings, /id="cli"/, 'the settings page must show the chosen bridge');
  assert.ok(!/console/i.test(settings), 'the settings page must not reimplement the console');
});

test('the CLI catalog installs and presets an engine instead of asking for a path', () => {
  assert.match(main, /const CLI_CATALOG = \[/);
  assert.match(main, /'@openai\/codex'/, 'Codex CLI must be offered');
  assert.match(main, /'@oh-my-pi\/pi-coding-agent'/, 'OMP must be offered');
  assert.match(main, /codex-bridge\.mjs/);
  assert.match(main, /omp-json-bridge\.mjs/);
  // One-click install runs npm against the catalog package.
  assert.match(main, /execFile\(npm, \['install', '-g', entry\.package\]/);
  // The catalog reports what the bridge will actually find.
  assert.match(main, /npm', 'node_modules'\)/);
  // The command is derived, never typed: a hand-written path cannot break it.
  assert.match(main, /next\.backendCommand = next\.backendArgs\.length/);
});

test('the settings window never receives the credential', () => {
  const start = main.indexOf("workflow:settings-get");
  const end = main.indexOf("workflow:settings-save");
  assert.ok(start > 0 && end > start, 'both settings handlers must exist');
  const handler = main.slice(start, end);
  assert.ok(!/getToken\(\)/.test(handler), 'the settings response must not read the token');
  assert.match(handler, /publicConfig\(\)/, 'the response must come from the redacted view');
});

test('the settings page renders the catalog and the saved engine', async () => {
  const html = fs.readFileSync(path.join(root, '../settings.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const bridge = 'C:/app/resources/workflow-core/packages/worker/bin/omp-json-bridge.mjs';
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, { id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, addEventListener() {} });
    }
    return elements.get(id);
  };
  const sandbox = {
    console,
    setInterval: () => ({ unref() {} }),
    document: { getElementById: element },
    window: {
      workflowDesktop: {
        settings: {
          get: async () => ({
            serverUrl: 'https://core.example:8710',
            workerId: 'worker-test',
            backendCommand: 'node',
            backendArgs: [bridge, '--model', 'deepseek/x'],
            hasToken: true,
            executor: { running: false, pid: null, restarts: 0, lastError: null },
          }),
          save: async () => ({ ok: true }),
          catalog: async () => ([
            {
              id: 'omp', label: 'OMP（oh-my-pi）', description: 'oh-my-pi', package: '@oh-my-pi/pi-coding-agent',
              installed: true, bridgePath: bridge,
              params: [{ flag: '--model', label: '模型', placeholder: 'x' }],
            },
            {
              id: 'codex', label: 'Codex CLI', description: 'codex', package: '@openai/codex',
              installed: false, bridgePath: 'C:/app/resources/workflow-core/packages/worker/bin/codex-bridge.mjs',
              params: [{ flag: '--model', label: '模型', placeholder: 'gpt-5-codex' }],
            },
          ]),
          installCli: async () => ({ ok: true, output: '' }),
        },
        executor: { start: async () => ({}), stop: async () => ({}) },
      },
    },
  };
  vm.runInNewContext(script, sandbox, { filename: 'settings-inline.js' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(element('catalog').innerHTML, /OMP（oh-my-pi）/, 'the catalog is listed');
  assert.match(element('catalog').innerHTML, /已安装/, 'installed state is shown');
  assert.match(element('catalog').innerHTML, /未安装/, 'a missing CLI is shown as such');
  assert.equal(element('cli').value, bridge, 'the saved bridge is recognised and shown');
  assert.match(element('params').innerHTML, /data-param="--model"/, 'the saved CLI keeps its parameter field');
  assert.equal(element('serverUrl').value, 'https://core.example:8710');
  assert.equal(element('workerId').value, 'worker-test');
  assert.match(element('state').textContent, /已停止/);
  assert.match(element('access').textContent, /凭据已配置/);
  assert.equal(element('start').disabled, false, 'a stopped executor can be started');
  assert.equal(element('stop').disabled, true, 'a stopped executor cannot be stopped');
});

test('a background app has a way back in and a way out', () => {
  assert.match(main, /new Tray\(/);
  assert.match(main, /本机设置/);
  assert.match(main, /退出 Workflow/);
  // Windows hides tray icons in the overflow, so a second launch must hand
  // over to the running instance and ask for the settings window.
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /second-instance/);
  assert.match(main, /app\.hasSingleInstanceLock\(\)/);
  // The settings window opens on first run, when no engine is configured yet.
  assert.match(main, /if \(!configStore\.read\(\)\.backendCommand\) createSettingsWindow\(\)/);
});

test('the periodic tick never overwrites the form being edited', () => {
  const settings = fs.readFileSync(path.join(root, '../settings.html'), 'utf8');
  // Only the status refreshes on a timer; the form is filled on open and save.
  assert.match(settings, /setInterval\(refreshStatus, 5000\)/);
  assert.ok(!/setInterval\(refresh,/.test(settings), 'the tick must not re-run the whole form load');
  assert.match(settings, /function loadForm\(\)/);
  assert.match(settings, /function refreshStatus\(\)/);
  // A bridge path recorded before the app moved must still map to its entry.
  assert.match(settings, /function bridgeName\(/);
});

test('the preload exposes capabilities, not privileges', () => {
  const exposed = [...preload.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((match) => match[1]).sort();
  assert.deepEqual(exposed, ['executor', 'idleBucket', 'notify', 'platform', 'serverUrl', 'settings']);
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

test('the shell has no menu bar and explains a failed load', () => {
  assert.match(main, /Menu\.setApplicationMenu\(null\)/, 'the default Electron menu is noise here');
  assert.match(main, /function fallbackHtml/, 'a blank window must explain itself');
  assert.match(main, /did-fail-load/, 'load failures must be reported');
  // The fallback must not reload itself forever.
  assert.match(main, /startsWith\('data:'\)/);
});
