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
    'data-revert=', 'data-suggestion=',
    '/api/v1/presence', '/api/v1/replies?limit=', '/api/v1/ai/metrics', '/api/v1/ai/checkup', '/api/v1/auth/bootstrap', 'visibilitychange',
    '/api/v1/commitments?state=active', '/api/v1/tasks?limit=', '/api/v1/admin/peers', '/api/v1/admin/peer-sync',
    '/api/v1/digest/pending', '/api/v1/signals', '/events?limit=',
    '/api/v1/workflow/memories?', '/api/v1/skills',
    'data-task="', 'data-filter="', 'data-goto="', 'data-knowledge="', 'data-skill="',
  ]) {
    assert.ok(CONSOLE_HTML.includes(call), `missing API call: ${call}`);
  }
  assert.ok(CONSOLE_HTML.includes('function esc('), 'rendered server values must be escaped');
  assert.ok(CONSOLE_HTML.includes('response.status === 401'), 'an expired session must return to the login view');
});

test('the console keeps the sidebar navigation from the design baseline', () => {
  assert.ok(CONSOLE_HTML.includes('class="sidebar"'), 'the sidebar is the primary navigation');
  assert.ok(CONSOLE_HTML.includes('class="nav-label">助理'), 'assistant navigation group');
  assert.ok(CONSOLE_HTML.includes('class="nav-label">运维'), 'operations navigation group');
  assert.ok(CONSOLE_HTML.includes('class="sidebar-foot"'), 'the presence footer lives in the sidebar');
  for (const view of ['today', 'proposals', 'commitments', 'chat', 'memory', 'knowledge', 'tasks', 'nodes', 'skills', 'replies', 'checkup']) {
    assert.ok(CONSOLE_HTML.includes(`navItem('${view}'`), `missing navigation entry: ${view}`);
    // 今日 is the fallback branch, so it has no explicit view comparison.
    const branch = view === 'today' ? 'todayView()' : `state.view === '${view}'`;
    assert.ok(CONSOLE_HTML.includes(branch), `missing view branch: ${view}`);
  }
  // 同步 has no page of its own: it answers the same question as 节点.
  assert.ok(!CONSOLE_HTML.includes("navItem('sync'"), 'sync must not be a separate navigation entry');
});

test('the console source references no remote assets', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(root, '../src/console/app.js'), 'utf8');
  assert.ok(!/https?:\/\//.test(source), 'no remote assets may be referenced');
});
