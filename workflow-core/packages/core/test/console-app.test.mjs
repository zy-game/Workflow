// console-app.test.mjs - the console page is served without a build step and
// stays dependency-free: no framework CDN, and every server value it renders
// goes through escaping.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { CONSOLE_HTML } from '../src/console/app.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { TaskRepository } from '../src/tasks/repository.js';

let dir;
let auth;
let coreDb;
let server;
let base;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-console-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDb = new CoreDatabase({ dataDir: dir });
  const app = createCoreServer({ config: {}, authRepository: auth, taskRepository: new TaskRepository({ coreDb }) });
  server = await app.listen({ host: '127.0.0.1', port: 0, tls: null });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  coreDb.close();
  auth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the console page is served at /console and /console/', async () => {
  for (const pathname of ['/console', '/console/']) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /Workflow 控制台/);
  }
});

test('the console ships without a framework or CDN dependency', () => {
  assert.ok(!/unpkg|jsdelivr|cdn\./i.test(CONSOLE_HTML), 'no CDN may be referenced');
  assert.ok(!/<script[^>]+src=/i.test(CONSOLE_HTML), 'no external script may be loaded');
  assert.ok(CONSOLE_HTML.includes("document.getElementById('root')"));
});

test('the console carries the design tokens and the real API calls', () => {
  for (const token of ['--accent:#6c8cff', '--surface:#14171e', '--r-card:8px', '--mono:ui-monospace']) {
    assert.ok(CONSOLE_HTML.includes(token), `missing design token: ${token}`);
  }
  for (const call of [
    '/api/v1/auth/client-login', '/api/v1/proposals?state=pending',
    'data-act="approve"', 'data-act="reject"', 'data-act="send"',
    '/api/v1/memory/tree', '/api/v1/memory/file?path=', '/api/v1/memory/history?path=', '/api/v1/memory/revert',
    'data-nav="memory"', 'data-revert=', '/api/v1/presence', 'visibilitychange',
  ]) {
    assert.ok(CONSOLE_HTML.includes(call), `missing API call: ${call}`);
  }
  assert.ok(CONSOLE_HTML.includes('function esc('), 'rendered server values must be escaped');
  assert.ok(CONSOLE_HTML.includes('response.status === 401'), 'an expired session must return to the login view');
});

test('the console source references no remote assets', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(root, '../src/console/app.js'), 'utf8');
  assert.ok(!/https?:\/\//.test(source), 'no remote assets may be referenced');
});
