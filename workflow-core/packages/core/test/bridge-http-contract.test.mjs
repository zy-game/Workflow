import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { BridgeRequestsRepository } from '../src/bridge/requests-repository.js';
import { createBridgeService } from '../src/bridge/service.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { InteractionRepository } from '../src/interactions/repository.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { WorkersRegistry } from '../src/workers/registry.js';

let dir;
let auth;
let coreDatabase;
let tasks;
let workers;
let server;
let base;
let bridgeToken;
let bridgeTokenId;

async function call(pathname, { token = bridgeToken, body = {} } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-bridge-http-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDatabase = new CoreDatabase({ dataDir: dir });
  tasks = new TaskRepository({ coreDb: coreDatabase });
  workers = new WorkersRegistry({ coreDb: coreDatabase });
  const interactions = new InteractionRepository({ coreDb: coreDatabase });
  const requests = new BridgeRequestsRepository({ coreDb: coreDatabase });
  const bridgeService = createBridgeService({
    bridgeRequestsRepository: requests,
    workersRegistry: workers,
    taskRepository: tasks,
    interactionRepository: interactions,
  });
  const created = auth.createMachineToken({
    subject_id: 'unity-a', role: 'bridge', project_ids: ['project-a'],
  });
  bridgeToken = created.token;
  bridgeTokenId = created.token_id;
  const app = createCoreServer({
    config: {}, authRepository: auth, taskRepository: tasks,
    interactionRepository: interactions, workersRegistry: workers, bridgeService,
  });
  server = await app.listen({ host: '127.0.0.1', port: 0, tls: null });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  coreDatabase.close();
  auth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Bridge HTTP requires a dedicated machine token and narrows registration scope', async () => {
  const worker = auth.createMachineToken({ subject_id: 'worker-a', role: 'worker', project_ids: ['project-a'] });
  const forbidden = await call('/api/v1/bridge/register', {
    token: worker.token,
    body: { request_id: 'register-worker', protocol_version: 1, metadata: {} },
  });
  assert.equal(forbidden.status, 403);

  const registration = await call('/api/v1/bridge/register', {
    body: {
      request_id: 'register-1', protocol_version: 1,
      metadata: {
        projects: ['project-a'], max_concurrency: 1, capabilities: ['run'],
        backends: [{ kind: 'workflow-jsonl', capabilities: ['run'] }],
      },
    },
  });
  assert.equal(registration.status, 200);
  assert.equal(registration.body.worker.worker_id, 'unity-a');
  assert.deepEqual(registration.body.worker.projects, ['project-a']);

  const scope = await call('/api/v1/bridge/register', {
    body: { request_id: 'register-scope', protocol_version: 1, metadata: { projects: ['project-b'] } },
  });
  assert.equal(scope.status, 403);
  assert.equal(scope.body.code, 'BRIDGE_PROJECT_FORBIDDEN');
});

test('Bridge HTTP pull is durable, active-first, and rejects changed replay payloads', async () => {
  const task = tasks.create({
    type: 'code', brief: { prompt: 'run' }, created_by: 'test', project_id: 'project-a',
    idempotency_key: 'bridge-http-task', backend_kind: 'workflow-jsonl', required_capabilities: ['run'],
  }).task;
  const first = await call('/api/v1/bridge/tasks/pull', {
    body: { request_id: 'pull-1', protocol_version: 1, state: 'running' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.claims.length, 1);
  assert.equal(first.body.claims[0].task.task_id, task.task_id);
  assert.equal(first.body.claims[0].resumed, false);
  assert.equal(tasks.get(task.task_id).attempts, 1);

  const replay = await call('/api/v1/bridge/tasks/pull', {
    body: { protocol_version: 1, state: 'running', request_id: 'pull-1' },
  });
  assert.deepEqual(replay.body, first.body);
  assert.equal(tasks.get(task.task_id).attempts, 1);

  const conflict = await call('/api/v1/bridge/tasks/pull', {
    body: { request_id: 'pull-1', protocol_version: 1, state: 'paused' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'BRIDGE_REQUEST_CONFLICT');
});

test('Bridge HTTP preserves service statuses, terminal conflicts, and token revocation', async () => {
  const active = tasks.activeForWorker('unity-a')[0];
  const oversized = await call(`/api/v1/bridge/tasks/${active.task_id}/events`, {
    body: {
      request_id: 'events-large', protocol_version: 1, claim_token: active.claim_token,
      events: [{ event_id: 'large', text: 'x'.repeat(70 * 1024) }],
    },
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'BRIDGE_LIMIT_EXCEEDED');

  const result = await call(`/api/v1/bridge/tasks/${active.task_id}/result`, {
    body: {
      request_id: 'result-1', protocol_version: 1, claim_token: active.claim_token,
      kind: 'done', result: { summary: 'ok' },
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.task.status, 'done');

  const conflict = await call(`/api/v1/bridge/tasks/${active.task_id}/result`, {
    body: {
      request_id: 'result-2', protocol_version: 1, claim_token: active.claim_token,
      kind: 'failed', result: { error: 'changed' },
    },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'TASK_TERMINAL_CONFLICT');

  auth.revokeMachineToken(bridgeTokenId);
  const revoked = await call('/api/v1/bridge/tasks/pull', {
    body: { request_id: 'pull-revoked', protocol_version: 1 },
  });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.code, 'invalid_token');
});

test('generic REST task claim remains unavailable', async () => {
  const response = await call('/api/v1/tasks/claim', {
    body: { request_id: 'generic-claim', protocol_version: 1 },
  });
  assert.equal(response.status, 404);
});
