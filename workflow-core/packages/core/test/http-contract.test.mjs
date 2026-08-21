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

test('admin issues a worker machine token that can claim but not administer', async () => {
  const created = await call('POST', '/api/v1/admin/tokens', {
    token: adminToken, body: { subject_id: 'win-main', role: 'worker' },
  });
  assert.equal(created.status, 200);
  workerToken = created.body.token;
  const forbidden = await call('GET', '/api/v1/admin/tokens', { token: workerToken });
  assert.equal(forbidden.status, 403);
});

test('task lifecycle: create (auth-gated), claim by priority, progress, done', async () => {
  const anonymous = await call('POST', '/api/v1/tasks', { body: { type: 'dsh.run', brief: { goal: 'x' } } });
  assert.equal(anonymous.status, 401);

  const low = await call('POST', '/api/v1/tasks', {
    token: adminToken,
    body: { type: 'dsh.run', brief: { goal: 'low' }, priority: 8, worker_selector: { tag: 'http' } },
  });
  const high = await call('POST', '/api/v1/tasks', {
    token: adminToken,
    body: { type: 'dsh.run', brief: { goal: 'high' }, priority: 1, worker_selector: { tag: 'http' } },
  });
  assert.equal(low.status, 200);
  assert.equal(high.status, 200);

  // feishu role may create but never claim
  const feishuIssued = await call('POST', '/api/v1/admin/tokens', {
    token: adminToken, body: { subject_id: 'feishu-1', role: 'feishu' },
  });
  const feishuToken = feishuIssued.body.token;
  const feishuCreate = await call('POST', '/api/v1/tasks', {
    token: feishuToken, body: { type: 'feishu.triage', brief: { message: 'hello' }, worker_selector: { tag: 'http' } },
  });
  assert.equal(feishuCreate.status, 200);
  const feishuClaim = await call('POST', '/api/v1/tasks/claim', {
    token: feishuToken, body: { selector: { tag: 'http' } },
  });
  assert.equal(feishuClaim.status, 403);

  // Priority order among the three tagged tasks: high(1) < feishu(5) < low(8).
  const claimHigh = await call('POST', '/api/v1/tasks/claim', {
    token: workerToken, body: { worker_id: 'machine:win-main', selector: { tag: 'http' } },
  });
  assert.equal(claimHigh.status, 200);
  assert.equal(claimHigh.body.task.task_id, high.body.task.task_id);
  const claimFeishuTask = await call('POST', '/api/v1/tasks/claim', {
    token: workerToken, body: { worker_id: 'machine:win-main', selector: { tag: 'http' } },
  });
  assert.equal(claimFeishuTask.body.task.task_id, feishuCreate.body.task.task_id);
  const claimLow = await call('POST', '/api/v1/tasks/claim', {
    token: workerToken, body: { worker_id: 'machine:win-main', selector: { tag: 'http' } },
  });
  assert.equal(claimLow.body.task.task_id, low.body.task.task_id);

  const taskId = claimHigh.body.task.task_id;
  const claimToken = claimHigh.body.task.claim_token;
  const progress = await call('POST', `/api/v1/tasks/${taskId}/progress`, {
    token: workerToken,
    body: { claim_token: claimToken, note: 'running tools', events: [{ kind: 'tool/call', tool: 'shell' }] },
  });
  assert.equal(progress.body.task.status, 'running');
  const forged = await call('POST', `/api/v1/tasks/${taskId}/done`, {
    token: workerToken, body: { claim_token: 'forged', kind: 'done' },
  });
  assert.equal(forged.status, 400);
  const done = await call('POST', `/api/v1/tasks/${taskId}/done`, {
    token: workerToken, body: { claim_token: claimToken, kind: 'done', result: { summary: 'finished' } },
  });
  assert.equal(done.body.task.status, 'done');

  const events = await call('GET', `/api/v1/tasks/${taskId}/events`, { token: workerToken });
  const types = events.body.events.map((event) => event.type);
  assert.deepEqual(types, ['created', 'claimed', 'progress', 'session_event', 'done']);

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
