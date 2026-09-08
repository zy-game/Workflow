// probe-channel.test.mjs - a probe reaches a Worker over the existing control
// channel, and the Worker's read-only answer is recorded without touching the
// task or claim path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { frame } from '@workflow-core/shared';
import { AuthRepository } from '../src/auth/repository.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { InteractionRepository } from '../src/interactions/repository.js';
import { WorkflowRepository } from '../src/knowledge/repository.js';
import { ProbeRepository } from '../src/probe/repository.js';
import { createProbeService } from '../src/probe/service.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { WorkersRegistry } from '../src/workers/registry.js';
import { createWorkerChannel } from '../src/ws/channel.js';

let dir;
let auth;
let coreDb;
let tasks;
let knowledge;
let workers;
let channel;
let server;
let base;
let adminToken;
let workerToken;
let projectId;

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

function connectWorker() {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/worker`, {
    headers: { authorization: `Bearer ${workerToken}` },
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
  const next = (predicate, label, timeoutMs = 4000) => new Promise((resolve, reject) => {
    const existing = received.find(predicate);
    if (existing) return resolve(existing);
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs),
    };
    waiters.push(waiter);
  });
  return { socket, received, opened, next, send: (type, payload) => socket.send(JSON.stringify(frame(type, payload))) };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-probe-ws-'));
  auth = new AuthRepository({ dataDir: dir });
  await auth.createAccount({ email: 'owner@example.com', password: 'correct-horse-battery' });
  coreDb = new CoreDatabase({ dataDir: dir });
  tasks = new TaskRepository({ coreDb, claimTimeoutMs: 60_000, nodeId: 'node-test' });
  knowledge = new WorkflowRepository({ filename: path.join(dir, 'workflow.db') });
  workers = new WorkersRegistry({ coreDb });
  const probeService = createProbeService({
    probeRepository: new ProbeRepository({ coreDb }),
    knowledgeRepository: knowledge,
  });
  channel = createWorkerChannel({
    authRepository: auth,
    taskRepository: tasks,
    interactionRepository: new InteractionRepository({ coreDb }),
    workersRegistry: workers,
    probeService,
  });
  const core = createCoreServer({
    config: {},
    authRepository: auth,
    taskRepository: tasks,
    workersRegistry: workers,
    workerChannel: channel,
    knowledgeRepository: knowledge,
    probeService,
    nodeId: 'node-test',
  });
  server = await core.listen({ host: '127.0.0.1', port: 0, tls: null });
  channel.handleUpgrade(server);
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/v1/auth/client-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }),
  });
  adminToken = (await login.json()).access_token;
  projectId = knowledge.resolveProject({ path: '/srv/channel-project', machine: 'channel-box' }).id;
  const created = await api('POST', '/api/v1/admin/tokens', {
    token: adminToken,
    body: { subject_id: 'probe-worker', role: 'worker', project_ids: [projectId] },
  });
  workerToken = created.body.token;
});

after(async () => {
  channel.stop();
  await new Promise((resolve) => server.close(resolve));
  knowledge.close();
  auth.close();
  coreDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a probe reaches the worker over the control channel and its answer is recorded', async () => {
  const worker = connectWorker();
  await worker.opened;
  worker.send('register', { worker_id: 'probe-worker', machine: 'probe-box', projects: [projectId], max_concurrency: 1 });
  await worker.next((value) => value.type === 'config', 'worker config');

  const created = await api('POST', '/api/v1/probe', {
    token: adminToken,
    body: { probe_id: 'probe-ws-1', project_id: projectId, question: '构建通过了吗', budget_ms: 60000 },
  });
  assert.equal(created.status, 200, `projectId=${projectId} body=${JSON.stringify(created.body)}`);

  // A heartbeat makes the channel run its dispatch pass, which also delivers
  // queued probes for the worker's projects.
  worker.send('heartbeat', { state: 'running' });
  const request = await worker.next((value) => value.type === 'probe_request', 'probe_request');
  assert.equal(request.payload.probe_id, 'probe-ws-1');
  assert.equal(request.payload.question, '构建通过了吗');
  assert.equal(tasks.list({ limit: 10 }).length, 0);

  worker.send('probe_result', {
    probe_id: 'probe-ws-1',
    verdict: 'done',
    confidence: 0.75,
    evidence: [{ kind: 'test', ref: '12 passed' }],
    suggested_reply: '已通过',
  });
  await worker.next((value) => value.type === 'ack' && value.payload?.frame_id === undefined, 'ack', 200)
    .catch(() => null);

  const read = await api('GET', '/api/v1/probe/probe-ws-1', { token: adminToken });
  assert.equal(read.body.probe.state, 'answered');
  assert.equal(read.body.probe.verdict, 'done');
  assert.equal(read.body.probe.evidence[0].ref, '12 passed');
  assert.equal(tasks.list({ limit: 10 }).length, 0);
  worker.socket.close();
});
