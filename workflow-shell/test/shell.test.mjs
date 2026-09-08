// shell.test.mjs - source contracts for the desktop shell.
//
// The shell is thin on purpose: it must not become a second UI, and it must not
// hand the console a privileged surface. These checks run without launching
// Electron, so they guard the shape of the app rather than its pixels.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(root, '../main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, '../preload.js'), 'utf8');
const console_ = fs.readFileSync(path.join(root, '../../workflow-core/packages/core/src/console/app.js'), 'utf8');

test('the shell loads the server-hosted console instead of its own UI', () => {
  assert.match(main, /loadURL\(`\$\{SERVER_URL\}\/console`\)/);
  assert.match(main, /WORKFLOW_SERVER_URL/);
  // No local HTML to drift out of sync with the console.
  assert.ok(!fs.existsSync(path.join(root, '../index.html')), 'the shell must not ship its own page');
});

test('the preload exposes capabilities, not privileges', () => {
  const exposed = [...preload.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((match) => match[1]).sort();
  assert.deepEqual(exposed, ['idleBucket', 'notify', 'platform', 'serverUrl']);
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
