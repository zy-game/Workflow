// worker-channel.test.mjs - end-to-end M2 loop: a real WebSocket worker
// registers, receives a model push, gets a task dispatched over the wire,
// reports progress/session events, and completes it. Also covers upgrade
// auth rejection, registry push, and central-DSH model sync.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { AuthRepository } from '../src/auth/repository.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { WorkersRegistry } from '../src/workers/registry.js';
import { ModelRegistry } from '../src/models/registry.js';
import { DshLocalClient, DshModelSync } from '../src/models/dsh-sync.js';
import { ProbeRunner } from '../src/models/probe.js';
import { createWorkerChannel } from '../src/ws/channel.js';
import { createCoreServer } from '../src/http/server.js';

let dir;
let auth;
let coreDb;
let tasks;
let workers;
let models;
let channel;
let server;
let base;
let adminToken;
let workerToken;
let dshCalls;
let fakeDsh;

// Minimal fake central DSH exposing the deployed provider/settings contract.
function startFakeDsh() {
  const calls = [];
  const handle = (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const method = req.url.replace('/api/', '');
      calls.push({ method, payload: parsed.payload });
      let value = {};
      if (method === 'llm.providers') {
        value = { providers: [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] }] };
      } else if (method === 'settings.describe') {
        value = { writable: true, namespaces: [
          { ns: 'llm-deepseek', revision: 0, value: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-v4-flash' }] } },
          { ns: 'agent-default-model', revision: 0, value: { provider: 'other', model: 'other-model' } },
        ] };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'server-response', rpcId: parsed.rpcId, result: { ok: true, value },
      }));
    });
  };
  const dsh = http.createServer(handle);
  return { server: dsh, calls, url: '' };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-ws-'));
  auth = new AuthRepository({ dataDir: dir });
  await auth.createAccount({ email: 'owner@example.com', password: 'correct-horse-battery' });
  coreDb = new CoreDatabase({ dataDir: dir });
  tasks = new TaskRepository({ coreDb, claimTimeoutMs: 60_000 });
  workers = new WorkersRegistry({ coreDb });
  models = new ModelRegistry({ coreDb });

  fakeDsh = startFakeDsh();
  await new Promise((resolve) => fakeDsh.server.listen(0, '127.0.0.1', resolve));
  fakeDsh.url = `http://127.0.0.1:${fakeDsh.server.address().port}`;
  dshCalls = fakeDsh.calls;
  const dshSync = new DshModelSync({ client: new DshLocalClient({ baseUrl: fakeDsh.url }) });

  channel = createWorkerChannel({ authRepository: auth, taskRepository: tasks, workersRegistry: workers, modelRegistry: models, dshSync });
  const core = createCoreServer({ config: {}, authRepository: auth, taskRepository: tasks, workersRegistry: workers, modelRegistry: models, workerChannel: channel });
  server = await core.listen({ host: '127.0.0.1', port: 0, tls: null });
  channel.handleUpgrade(server);
  base = `http://127.0.0.1:${server.address().port}`;

  const issue = async (role, subject) => {
    const response = await fetch(`${base}/api/v1/auth/client-login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }),
    });
    const { access_token } = await response.json();
    const created = await fetch(`${base}/api/v1/admin/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` },
      body: JSON.stringify({ subject_id: subject, role }),
    });
    const body = await created.json();
    return body.token;
  };
  adminToken = await issue('admin', 'admin-console');
  workerToken = await issue('worker', 'win-main');
});

after(() => {
  channel.stop();
  server.close();
  fakeDsh.server.close();
  auth.close();
  coreDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function api(method, pathname, { token, body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function connectWorker(token) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/worker`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const received = [];
  const waiters = [];
  socket.on('message', (data) => {
    const frameValue = JSON.parse(data.toString());
    received.push(frameValue);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      const match = waiter.predicate(frameValue);
      if (match) {
        waiters.splice(index, 1);
        waiter.resolve(frameValue);
      }
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  const next = (predicate, label, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const existing = received.find(predicate);
    if (existing) return resolve(existing);
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    waiters.push({ predicate, resolve: (value) => { clearTimeout(timer); resolve(value); } });
  });
  return { socket, opened, next, received };
}

test('upgrade without a worker token is rejected', async () => {
  const bad = connectWorker('not-a-token');
  await assert.rejects(() => bad.opened, /unexpected server response|401/);
});

test('worker registers, receives config + models push, gets dispatched, and completes', async () => {
  let worker = connectWorker(workerToken);
  await worker.opened;
  try {
    worker.socket.send(JSON.stringify({
      type: 'register', id: 'reg-1', ts: new Date().toISOString(),
      payload: {
        worker_id: 'win-main', machine: 'windows-main',
        capabilities: ['dsh', 'node'], selector: { capabilities: ['dsh', 'node'] },
        max_concurrency: 2, version: '0.1.0',
      },
    }));
    const configFrame = await worker.next((f) => f.type === 'config', 'config frame');
    assert.equal(configFrame.payload.protocol_version, 1);
    assert.equal(configFrame.payload.worker.worker_id, 'win-main');

    // Adding a model pushes to the registered worker and syncs central DSH.
    // (register itself sends an initial empty models frame - skip it.)
    await api('POST', '/api/v1/admin/models', {
      token: adminToken,
      body: { provider: 'deepseek-official', model: 'deepseek-v4-flash', key: 'sk-first', baseUrl: 'https://api.deepseek.com', priority: 1 },
    });
    const pushFrame = await worker.next((f) => f.type === 'models' && f.payload.models.length >= 1, 'models push');
    assert.equal(pushFrame.payload.models[0].provider, 'deepseek-official');
    assert.equal(pushFrame.payload.models[0].model, 'deepseek-v4-flash');
    assert.equal(pushFrame.payload.models[0].key, 'sk-first');
    const dshSet = dshCalls.find((call) => call.method === 'credentials.set');
    assert.ok(dshSet, 'credentials.set reached central DSH');
    assert.equal(dshSet.payload.ref, 'DEEPSEEK_API_KEY');
    assert.equal(dshSet.payload.value, 'sk-first');
    const selection = dshCalls.find((call) => call.method === 'settings.mutate' && call.payload.ns === 'agent-default-model');
    assert.deepEqual(selection.payload.ops, [
      { op: 'set', path: ['provider'], value: 'deepseek-official' },
      { op: 'set', path: ['model'], value: 'deepseek-v4-flash' },
    ]);

  const created = await api('POST', '/api/v1/tasks', {
    token: adminToken,
    body: { type: 'dsh.run', brief: { goal: 'run the suite' }, worker_selector: { capabilities: ['dsh'] } },
  });
  assert.equal(created.status, 200);

  const dispatch = await worker.next((f) => f.type === 'dispatch', 'dispatch frame');
  const task = dispatch.payload.task;
  assert.equal(task.brief.goal, 'run the suite');
  assert.ok(task.claim_token);

  worker.socket.send(JSON.stringify({
    type: 'progress', id: 'p-1', ts: new Date().toISOString(),
    payload: { task_id: task.task_id, claim_token: task.claim_token, note: 'halfway', percent: 50 },
  }));
  worker.socket.send(JSON.stringify({
    type: 'session_event', id: 'se-1', ts: new Date().toISOString(),
    payload: { task_id: task.task_id, event: { kind: 'tool/call', tool: 'shell', args: { cmd: 'npm test' } } },
  }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const progressState = await api('GET', `/api/v1/tasks/${task.task_id}`, { token: adminToken });
  assert.equal(progressState.body.task.status, 'running');

  worker.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 150));
  worker = connectWorker(workerToken);
  await worker.opened;
  worker.socket.send(JSON.stringify({
    type: 'register', id: 'reg-2', ts: new Date().toISOString(),
    payload: {
      worker_id: 'win-main', machine: 'windows-main',
      capabilities: ['dsh', 'node'], selector: { capabilities: ['dsh', 'node'] },
      max_concurrency: 2, version: '0.1.0',
    },
  }));
  await worker.next((f) => f.type === 'config', 'reconnect config frame');
  const resumed = await worker.next(
    (f) => f.type === 'dispatch' && f.payload.task.task_id === task.task_id,
    'resumed dispatch frame',
  );
  assert.equal(resumed.payload.resumed, true);
  assert.equal(resumed.payload.task.claim_token, task.claim_token);
  assert.equal(resumed.payload.task.attempts, 1);

  // A task owned by another worker cannot be mutated through this socket.
  worker.socket.send(JSON.stringify({
    type: 'progress', id: 'p-2', ts: new Date().toISOString(),
    payload: { task_id: 't-someone-elses', claim_token: 'x' },
  }));
  const errFrame = await worker.next((f) => f.type === 'error' && f.payload.in_reply_to === 'p-2', 'ownership rejection');
  assert.match(errFrame.payload.error, /does not exist/);

  worker.socket.send(JSON.stringify({
    type: 'task_done', id: 'd-1', ts: new Date().toISOString(),
    payload: { task_id: task.task_id, claim_token: task.claim_token, kind: 'done', result: { summary: 'suite green' } },
  }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const doneState = await api('GET', `/api/v1/tasks/${task.task_id}`, { token: adminToken });
  assert.equal(doneState.body.task.status, 'done');
  assert.equal(doneState.body.task.result.summary, 'suite green');

  const events = await api('GET', `/api/v1/tasks/${task.task_id}/events`, { token: adminToken });
  const types = events.body.events.map((event) => event.type);
  assert.deepEqual(types, ['created', 'claimed', 'progress', 'session_event', 'done']);

  const workerList = await api('GET', '/api/v1/workers', { token: adminToken });
  const listed = workerList.body.workers.find((entry) => entry.worker_id === 'win-main');
  assert.equal(listed.connected, true);
  } finally {
    worker.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const afterClose = await api('GET', '/api/v1/workers', { token: adminToken });
  const closed = afterClose.body.workers.find((entry) => entry.worker_id === 'win-main');
  assert.equal(closed.connected, false);
});

test('model registry revision survives restart and initializes during v4 migration', () => {
  const revisionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-model-revision-'));
  let database = new CoreDatabase({ dataDir: revisionDir });
  try {
    let registry = new ModelRegistry({ coreDb: database });
    assert.equal(registry.revision, 0);
    registry.upsert({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', key: 'test-key',
      baseUrl: 'https://api.deepseek.com', priority: 0,
    });
    assert.equal(registry.revision, 1);
    database.db.exec('DROP TABLE model_registry_state; PRAGMA user_version = 4');
    database.close();

    database = new CoreDatabase({ dataDir: revisionDir });
    registry = new ModelRegistry({ coreDb: database });
    assert.equal(registry.revision, 1);
    registry.upsert({
      provider: 'deepseek-official', model: 'deepseek-v4-pro', key: 'test-key-2',
      baseUrl: 'https://api.deepseek.com', priority: 1,
    });
    assert.equal(registry.revision, 2);
    database.close();

    database = new CoreDatabase({ dataDir: revisionDir });
    registry = new ModelRegistry({ coreDb: database });
    assert.equal(registry.revision, 2);
  } finally {
    database.close();
    fs.rmSync(revisionDir, { recursive: true, force: true });
  }
});

test('model probe failures demote priority then disable, and push follows health', async () => {
  const created = await api('POST', '/api/v1/admin/models', {
    token: adminToken,
    body: { provider: 'deepseek-official', model: 'flaky-model', key: 'sk-flaky', baseUrl: 'https://flaky.example.com', priority: 0 },
  });
  const modelId = created.body.model.model_id;

  const fail = (id) => api('POST', `/api/v1/admin/models/${id}/probe`, { token: adminToken });
  // The fake probe target does not exist, so probes fail naturally.
  await fail(modelId);
  await fail(modelId);
  let entry = (await api('GET', '/api/v1/admin/models', { token: adminToken })).body.models.find((m) => m.model_id === modelId);
  assert.equal(entry.priority, 0); // two failures: not yet demoted
  await fail(modelId);
  entry = (await api('GET', '/api/v1/admin/models', { token: adminToken })).body.models.find((m) => m.model_id === modelId);
  assert.equal(entry.priority, 1); // third failure: demoted
  assert.equal(entry.probe_status, 'fail');
  await fail(modelId); await fail(modelId); await fail(modelId);
  entry = (await api('GET', '/api/v1/admin/models', { token: adminToken })).body.models.find((m) => m.model_id === modelId);
  assert.equal(entry.enabled, false); // six failures: disabled

  const pushList = models.pushList();
  assert.ok(pushList.every((m) => m.model !== 'flaky-model'));
  assert.equal(pushList[0].model, 'deepseek-v4-flash');
});

test('probe runner uses stored credentials and redacts provider errors', async () => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-probe-key-'));
  const database = new CoreDatabase({ dataDir: probeDir });
  const registry = new ModelRegistry({ coreDb: database });
  const key = 'sk-sensitive-probe-key-123456';
  const created = registry.upsert({
    provider: 'deepseek-official', model: 'deepseek-v4-flash', key,
    baseUrl: 'https://api.deepseek.com', priority: 0,
  });
  let authorization = null;
  const runner = new ProbeRunner({
    registry,
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization;
      return new Response(JSON.stringify({ error: { message: `rejected ${key}` } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    },
  });
  try {
    const [outcome] = await runner.probeAll();
    assert.equal(authorization, `Bearer ${key}`);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.error.includes(key));
    assert.match(outcome.error, /\[REDACTED\]/);
    assert.equal(registry.get(created.model_id).consecutive_failures, 1);
  } finally {
    database.close();
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
});

test('probe against a reachable fake endpoint records ok with latency', async () => {
  const okProbe = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
  });
  await new Promise((resolve) => okProbe.listen(0, '127.0.0.1', resolve));
  try {
    const created = await api('POST', '/api/v1/admin/models', {
      token: adminToken,
      body: { provider: 'deepseek-official', model: 'healthy-model', key: 'sk-ok', baseUrl: `http://127.0.0.1:${okProbe.address().port}`, priority: 3 },
    });
    const outcome = await api('POST', `/api/v1/admin/models/${created.body.model.model_id}/probe`, { token: adminToken });
    assert.equal(outcome.body.outcome.ok, true);
    assert.ok(outcome.body.outcome.latencyMs >= 0);
    assert.equal(outcome.body.model.probe_status, 'ok');
    // Repeated successful probes of an already-ok model are not registry
    // changes: the revision counter must stay put.
    const revisionBefore = models.revision;
    await api('POST', `/api/v1/admin/models/${created.body.model.model_id}/probe`, { token: adminToken });
    await api('POST', `/api/v1/admin/models/${created.body.model.model_id}/probe`, { token: adminToken });
    assert.equal(models.revision, revisionBefore, 'routine ok probes do not bump the push revision');
  } finally {
    okProbe.close();
  }
});

test('inject reaches the owning worker only while the task is active', async () => {
  const worker = connectWorker(workerToken);
  await worker.opened;
  try {
    worker.socket.send(JSON.stringify({
      type: 'register', id: 'reg-2', ts: new Date().toISOString(),
      payload: { worker_id: 'win-inject', capabilities: [], selector: {}, max_concurrency: 1 },
    }));
    await worker.next((f) => f.type === 'config' && f.payload.worker.worker_id === 'win-inject', 'register ack');

    const created = await api('POST', '/api/v1/tasks', {
      token: adminToken,
      body: { type: 'dsh.run', brief: { goal: 'needs steering' }, worker_selector: {} },
    });
    const dispatch = await worker.next((f) => f.type === 'dispatch', 'dispatch');
    assert.equal(dispatch.payload.task.task_id, created.body.task.task_id);

    const injected = await api('POST', `/api/v1/tasks/${created.body.task.task_id}/inject`, {
      token: adminToken, body: { content: 'stop refactoring, run the tests instead' },
    });
    assert.equal(injected.body.ok, true);
    const injectFrame = await worker.next((f) => f.type === 'inject', 'inject frame');
    assert.equal(injectFrame.payload.content, 'stop refactoring, run the tests instead');

    const notAdmin = await api('POST', `/api/v1/tasks/${created.body.task.task_id}/inject`, {
      token: workerToken, body: { content: 'sneaky' },
    });
    assert.equal(notAdmin.status, 403);
  } finally {
    worker.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});
