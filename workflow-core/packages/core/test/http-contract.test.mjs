import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { createCoreServer } from '../src/http/server.js';

let dir;
let auth;
let tasks;
let server;
let base;
let adminToken;
let workerToken;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-http-'));
  auth = new AuthRepository({ dataDir: dir });
  await auth.createAccount({ email: 'owner@example.com', password: 'correct-horse-battery' });
  tasks = new TaskRepository({ dataDir: dir });
  const core = createCoreServer({ config: {}, authRepository: auth, taskRepository: tasks });
  server = await core.listen({ host: '127.0.0.1', port: 0, tls: null });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  auth.close();
  tasks.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, pathname, { token, body, cookie } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json, response };
}

test('health is public and reports both databases', async () => {
  const { status, body } = await call('GET', '/api/v1/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, 'workflow-core');
  assert.equal(body.checks.auth.ok, true);
  assert.equal(body.checks.core.ok, true);
});

test('admin page is public while admin APIs require an authenticated admin', async () => {
  const pageResponse = await fetch(`${base}/admin`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Workflow/);
  const anonymous = await call('GET', '/api/v1/admin/tokens');
  assert.equal(anonymous.status, 401);
});

test('client-login rejects wrong credentials and issues a revocable token', async () => {
  const bad = await call('POST', '/api/v1/auth/client-login', { body: { email: 'owner@example.com', password: 'wrong-password-1' } });
  assert.equal(bad.status, 401);
  const good = await call('POST', '/api/v1/auth/client-login', { body: { email: 'owner@example.com', password: 'correct-horse-battery' } });
  assert.equal(good.status, 200);
  assert.match(good.body.access_token, /^wfc-/);
  adminToken = good.body.access_token;
  const session = await call('GET', '/api/v1/auth/client-session', { token: adminToken });
  assert.equal(session.body.principal.email, 'owner@example.com');
  assert.equal(session.body.principal.actions[0], '*');
});

test('browser cookie login round-trips', async () => {
  const login = await call('POST', '/api/v1/auth/login', { body: { email: 'owner@example.com', password: 'correct-horse-battery' } });
  assert.equal(login.status, 200);
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  const session = await call('GET', '/api/v1/auth/session', { cookie });
  assert.equal(session.status, 200);
  assert.equal(session.body.principal.email, 'owner@example.com');
  const stranger = await call('GET', '/api/v1/auth/session', { cookie: `${cookie}x` });
  assert.equal(stranger.status, 401);
});

test('admin issues a worker machine token that cannot administer', async () => {
  const created = await call('POST', '/api/v1/admin/tokens', {
    token: adminToken, body: { subject_id: 'win-main', role: 'worker' },
  });
  assert.equal(created.status, 200);
  workerToken = created.body.token;
  const forbidden = await call('GET', '/api/v1/admin/tokens', { token: workerToken });
  assert.equal(forbidden.status, 403);
});

test('task HTTP surface creates, lists, and reads while execution stays on WebSocket', async () => {
  const anonymous = await call('POST', '/api/v1/tasks', { body: { type: 'workflow.run', brief: { goal: 'x' } } });
  assert.equal(anonymous.status, 401);

  const low = await call('POST', '/api/v1/tasks', {
    token: adminToken,
    body: { type: 'workflow.run', brief: { goal: 'low' }, priority: 8 },
  });
  const high = await call('POST', '/api/v1/tasks', {
    token: adminToken,
    body: { type: 'workflow.run', brief: { goal: 'high' }, priority: 1 },
  });
  assert.equal(low.status, 200);
  assert.equal(high.status, 200);

  const feishuIssued = await call('POST', '/api/v1/admin/tokens', {
    token: adminToken, body: { subject_id: 'feishu-1', role: 'feishu' },
  });
  const feishuCreate = await call('POST', '/api/v1/tasks', {
    token: feishuIssued.body.token,
    body: { type: 'feishu.triage', brief: { message: 'hello' } },
  });
  assert.equal(feishuCreate.status, 200);

  const tasksResponse = await call('GET', '/api/v1/tasks', { token: adminToken });
  const createdIds = tasksResponse.body.tasks.map((task) => task.task_id);
  assert.ok(createdIds.indexOf(high.body.task.task_id) < createdIds.indexOf(feishuCreate.body.task.task_id));
  assert.ok(createdIds.indexOf(feishuCreate.body.task.task_id) < createdIds.indexOf(low.body.task.task_id));

  const events = await call('GET', `/api/v1/tasks/${high.body.task.task_id}/events`, { token: adminToken });
  assert.deepEqual(events.body.events.map((event) => event.type), ['created']);

  const restClaim = await call('POST', '/api/v1/tasks/claim', {
    token: workerToken, body: { worker_id: 'win-main' },
  });
  assert.equal(restClaim.status, 404);

  const missing = await call('GET', '/api/v1/tasks/t-none', { token: adminToken });
  assert.equal(missing.status, 404);
});

test('client token logout invalidates further use', async () => {
  const logout = await call('POST', '/api/v1/auth/client-logout', { token: adminToken });
  assert.equal(logout.body.ok, true);
  const after = await call('GET', '/api/v1/auth/client-session', { token: adminToken });
  assert.equal(after.status, 401);
});

test('unknown routes return structured 404', async () => {
  const missing = await call('GET', '/api/v1/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'not_found');
});

test('CORS preflight and responses honor the configured origin allow-list', async () => {
  const core = createCoreServer({
    config: { corsOrigins: ['tauri://localhost'] },
    authRepository: auth,
    taskRepository: tasks,
  });
  const corsServer = await core.listen({ host: '127.0.0.1', port: 0, tls: null });
  try {
    const corsBase = `http://127.0.0.1:${corsServer.address().port}`;
    const preflight = await fetch(`${corsBase}/api/v1/tasks`, {
      method: 'OPTIONS',
      headers: { origin: 'tauri://localhost', 'access-control-request-method': 'GET' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'tauri://localhost');
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization, content-type');
    assert.equal(preflight.headers.get('access-control-max-age'), '600');

    // The task list requires a token, but CORS headers attach regardless of
    // the response status so the browser can read the 401 body.
    const unauthorized = await fetch(`${corsBase}/api/v1/tasks`, { headers: { origin: 'tauri://localhost' } });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('access-control-allow-origin'), 'tauri://localhost');

    const denied = await fetch(`${corsBase}/api/v1/tasks`, { headers: { origin: 'https://evil.example' } });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);

    const barePreflight = await fetch(`${corsBase}/api/v1/tasks`, { method: 'OPTIONS' });
    assert.equal(barePreflight.status, 204);
    assert.equal(barePreflight.headers.get('access-control-allow-origin'), null);
  } finally {
    corsServer.close();
  }
});
