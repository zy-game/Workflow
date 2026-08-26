import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { AuthRepository } from '../src/auth/repository.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { InteractionRepository } from '../src/interactions/repository.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { WorkersRegistry } from '../src/workers/registry.js';
import { createWorkerChannel } from '../src/ws/channel.js';
import { createCoreServer } from '../src/http/server.js';

let dir;
let auth;
let coreDb;
let tasks;
let interactions;
let workers;
let channel;
let server;
let base;
let adminToken;
let workerToken;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-ws-'));
  auth = new AuthRepository({ dataDir: dir });
  await auth.createAccount({ email: 'owner@example.com', password: 'correct-horse-battery' });
  coreDb = new CoreDatabase({ dataDir: dir });
  tasks = new TaskRepository({ coreDb, claimTimeoutMs: 60_000 });
  interactions = new InteractionRepository({ coreDb });
  workers = new WorkersRegistry({ coreDb });
  channel = createWorkerChannel({
    authRepository: auth,
    taskRepository: tasks,
    interactionRepository: interactions,
    workersRegistry: workers,
  });
  const core = createCoreServer({
    config: {},
    authRepository: auth,
    taskRepository: tasks,
    interactionRepository: interactions,
    workersRegistry: workers,
    workerChannel: channel,
  });
  server = await core.listen({ host: '127.0.0.1', port: 0, tls: null });
  channel.handleUpgrade(server);
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/v1/auth/client-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }),
  });
  adminToken = (await login.json()).access_token;
  const created = await api('POST', '/api/v1/admin/tokens', {
    token: adminToken,
    body: { subject_id: 'win-main', role: 'worker', project_ids: ['project-one'] },
  });
  workerToken = created.body.token;
});

after(async () => {
  channel.stop();
  await new Promise((resolve) => server.close(resolve));
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

function connectWorker(token = workerToken) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/worker`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const received = [];
  const waiters = [];
  socket.on('message', (data) => {
    const value = JSON.parse(data.toString());
    received.push(value);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter.predicate(value)) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  const next = (predicate, label, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const existing = received.find(predicate);
    if (existing) return resolve(existing);
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs),
    };
    waiters.push(waiter);
  });
  return { socket, opened, next, received };
}

function register(worker, overrides = {}) {
  worker.socket.send(JSON.stringify({
    type: 'register', id: `reg-${Date.now()}`, ts: new Date().toISOString(),
    payload: {
      worker_id: 'win-main',
      machine: 'windows-main',
      projects: ['project-one'],
      capabilities: ['node'],
      selector: { host: 'windows-main' },
      backends: [{ kind: 'workflow-jsonl', capabilities: ['resume', 'interactions'] }],
      state: 'running',
      config_revision: 2,
      max_concurrency: 2,
      version: '0.2.0',
      ...overrides,
    },
  }));
}

async function createTask(overrides = {}) {
  return api('POST', '/api/v1/tasks', {
    token: adminToken,
    body: {
      type: 'workflow.run',
      brief: { goal: 'run the suite' },
      project_id: 'project-one',
      backend_kind: 'workflow-jsonl',
      required_capabilities: ['resume'],
      ...overrides,
    },
  });
}

test('upgrade requires a worker token', async () => {
  const bad = connectWorker('not-a-token');
  await assert.rejects(() => bad.opened, /unexpected server response|401/i);
});

test('registration identity is bound to the token subject and project scope', async () => {
  const worker = connectWorker();
  await worker.opened;
  try {
    register(worker, { worker_id: 'another-worker' });
    const identityError = await worker.next((value) => value.type === 'error', 'identity error');
    assert.match(identityError.payload.error, /does not match token subject/);

    register(worker, { projects: ['project-two'] });
    const projectError = await worker.next(
      (value) => value.type === 'error' && value.id !== identityError.id,
      'project scope error',
    );
    assert.match(projectError.payload.error, /not permitted by worker token/);
  } finally {
    worker.socket.close();
  }
});

test('duplicate worker frames are acknowledged without repeating side effects', async () => {
  const worker = connectWorker();
  await worker.opened;
  try {
    register(worker);
    await worker.next((value) => value.type === 'config', 'config');
    const created = await createTask({ brief: { goal: 'dedupe progress' } });
    const dispatch = await worker.next(
      (value) => value.type === 'dispatch' && value.payload.task.task_id === created.body.task.task_id,
      'dispatch',
    );
    const payload = { task_id: dispatch.payload.task.task_id, claim_token: dispatch.payload.task.claim_token, note: 'once', percent: 10 };
    const raw = JSON.stringify({ type: 'progress', id: 'duplicate-progress', ts: new Date().toISOString(), payload });
    worker.socket.send(raw);
    const firstAck = await worker.next((value) => value.type === 'ack' && value.payload.frame_id === 'duplicate-progress', 'first ack');
    assert.equal(firstAck.payload.duplicate, undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    worker.socket.send(raw);
    const duplicateAck = await worker.next((value) => value.type === 'ack' && value.payload.frame_id === 'duplicate-progress' && value.payload.duplicate === true, 'duplicate ack');
    assert.equal(duplicateAck.payload.duplicate, true);
    assert.equal(tasks.get(dispatch.payload.task.task_id).status, 'running');
    worker.socket.send(JSON.stringify({
      type: 'task_done', id: 'dedupe-done', ts: new Date().toISOString(),
      payload: { task_id: dispatch.payload.task.task_id, claim_token: dispatch.payload.task.claim_token },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    worker.socket.close();
  }
});
test('worker claims only eligible backend tasks and resumes the same ownership', async () => {
  let worker = connectWorker();
  await worker.opened;
  try {
    register(worker);
    const config = await worker.next((value) => value.type === 'config', 'config');
    assert.equal(config.payload.protocol_version, 4);
    assert.equal(config.payload.worker.worker_id, 'win-main');
    assert.equal(config.payload.worker.config_revision, 2);

    const incompatible = await createTask({
      brief: { goal: 'needs an unavailable backend' },
      backend_kind: 'omp-rpc',
    });
    assert.equal(incompatible.status, 200);
    const created = await createTask();
    const dispatch = await worker.next(
      (value) => value.type === 'dispatch' && value.payload.task.task_id === created.body.task.task_id,
      'eligible dispatch',
    );
    const task = dispatch.payload.task;
    assert.equal(task.backend_kind, 'workflow-jsonl');
    assert.equal(tasks.get(incompatible.body.task.task_id).status, 'queued');

    worker.socket.send(JSON.stringify({
      type: 'progress', id: 'progress-1', ts: new Date().toISOString(),
      payload: { task_id: task.task_id, claim_token: task.claim_token, note: 'halfway', percent: 50 },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(tasks.get(task.task_id).status, 'running');

    worker.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    worker = connectWorker();
    await worker.opened;
    register(worker);
    await worker.next((value) => value.type === 'config', 'reconnect config');
    const resumed = await worker.next(
      (value) => value.type === 'dispatch' && value.payload.task.task_id === task.task_id,
      'resumed dispatch',
    );
    assert.equal(resumed.payload.resumed, true);
    assert.equal(resumed.payload.task.claim_token, task.claim_token);
    assert.equal(resumed.payload.task.attempts, 1);

    worker.socket.send(JSON.stringify({
      type: 'task_done', id: 'done-1', ts: new Date().toISOString(),
      payload: { task_id: task.task_id, claim_token: task.claim_token, result: { summary: 'suite green' } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(tasks.get(task.task_id).status, 'done');
    assert.equal(tasks.get(task.task_id).claim_worker_id, null);
  } finally {
    worker.socket.close();
  }
});

test('interaction response is persisted, delivered, acknowledged, and resumes the task', async () => {
  const worker = connectWorker();
  await worker.opened;
  try {
    register(worker);
    await worker.next((value) => value.type === 'config', 'config');
    const created = await createTask({ brief: { goal: 'ask before continuing' } });
    const dispatch = await worker.next(
      (value) => value.type === 'dispatch' && value.payload.task.task_id === created.body.task.task_id,
      'dispatch',
    );
    const task = dispatch.payload.task;
    worker.socket.send(JSON.stringify({
      type: 'interaction_required', id: 'interaction-1', ts: new Date().toISOString(),
      payload: {
        task_id: task.task_id,
        claim_token: task.claim_token,
        interaction_id: 'i-confirm',
        kind: 'question',
        schema: {
          questions: [{
            id: 'q-confirm', required: true,
            options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
          }],
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiting = tasks.get(task.task_id);
    assert.equal(waiting.status, 'awaiting_input');
    assert.equal(waiting.claim_token, task.claim_token);

    const answered = await api('POST', '/api/v1/interactions/i-confirm/respond', {
      token: adminToken,
      body: { response_id: 'r-confirm', answers: { 'q-confirm': 'yes' } },
    });
    assert.equal(answered.status, 200);
    assert.equal(answered.body.delivered, true);
    const response = await worker.next((value) => value.type === 'interaction_response', 'interaction response');
    assert.equal(response.payload.response.answers['q-confirm'], 'yes');
    assert.equal(tasks.get(task.task_id).status, 'awaiting_input');
    assert.equal(interactions.get('i-confirm').status, 'delivered');

    worker.socket.send(JSON.stringify({
      type: 'interaction_resolved', id: 'interaction-ack', ts: new Date().toISOString(),
      payload: {
        task_id: task.task_id,
        claim_token: task.claim_token,
        interaction_id: 'i-confirm',
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(interactions.get('i-confirm').status, 'consumed');
    assert.equal(tasks.get(task.task_id).status, 'running');
  } finally {
    worker.socket.close();
  }
});

test('credential interactions cannot be answered through Core HTTP', async () => {
  const worker = connectWorker();
  await worker.opened;
  try {
    register(worker);
    await worker.next((value) => value.type === 'config', 'config');
    const created = await createTask({ brief: { goal: 'authenticate locally' } });
    const dispatch = await worker.next(
      (value) => value.type === 'dispatch' && value.payload.task.task_id === created.body.task.task_id,
      'dispatch',
    );
    const task = dispatch.payload.task;
    worker.socket.send(JSON.stringify({
      type: 'interaction_required', id: 'credential-1', ts: new Date().toISOString(),
      payload: {
        task_id: task.task_id,
        claim_token: task.claim_token,
        interaction_id: 'i-credential',
        kind: 'credential',
        schema: { questions: [{ id: 'token', required: true }] },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await api('POST', '/api/v1/interactions/i-credential/respond', {
      token: adminToken,
      body: { response_id: 'r-secret', answers: { token: 'do-not-store' } },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'local_interaction_required');
    assert.equal(interactions.get('i-credential').response, null);
  } finally {
    worker.socket.close();
  }
});

test('draining workers do not receive new tasks', async () => {
  const worker = connectWorker();
  await worker.opened;
  try {
    register(worker, { state: 'draining' });
    await worker.next((value) => value.type === 'config', 'config');
    const created = await createTask({ brief: { goal: 'wait for running worker' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(tasks.get(created.body.task.task_id).status, 'queued');
  } finally {
    worker.socket.close();
  }
});
