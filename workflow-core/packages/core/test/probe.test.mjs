// probe.test.mjs - read-only status inquiries. A probe is delivered on the
// executor's own Bridge pull and answered with a verdict the caller can act
// on. It must never create a task, claim a lease, or accept a public claim
// without evidence.
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
import { WorkflowRepository } from '../src/knowledge/repository.js';
import { ProbeRepository } from '../src/probe/repository.js';
import { createProbeService } from '../src/probe/service.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { WorkersRegistry } from '../src/workers/registry.js';

let dir;
let auth;
let coreDatabase;
let tasks;
let workers;
let probes;
let knowledge;
let server;
let base;
let bridgeToken;
let adminToken;
let projectId;

async function call(pathname, { token = adminToken, method = 'POST', body = {} } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const options = { method, headers };
  if (method !== 'GET') options.body = JSON.stringify(body);
  const response = await fetch(`${base}${pathname}`, options);
  return { status: response.status, body: await response.json() };
}

function registerBridge() {
  return call('/api/v1/bridge/register', {
    token: bridgeToken,
    body: {
      request_id: `reg-${Math.random()}`,
      protocol_version: 1,
      metadata: { projects: [projectId], max_concurrency: 1 },
    },
  });
}

function pull() {
  return call('/api/v1/bridge/tasks/pull', {
    token: bridgeToken,
    body: { request_id: `pull-${Math.random()}`, protocol_version: 1 },
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-probe-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDatabase = new CoreDatabase({ dataDir: dir });
  tasks = new TaskRepository({ coreDb: coreDatabase });
  workers = new WorkersRegistry({ coreDb: coreDatabase });
  knowledge = new WorkflowRepository({ filename: path.join(dir, 'workflow.db') });
  const interactions = new InteractionRepository({ coreDb: coreDatabase });
  const requests = new BridgeRequestsRepository({ coreDb: coreDatabase });
  const probeRepository = new ProbeRepository({ coreDb: coreDatabase });
  probes = createProbeService({ probeRepository, knowledgeRepository: knowledge });
  const bridgeService = createBridgeService({
    bridgeRequestsRepository: requests,
    workersRegistry: workers,
    taskRepository: tasks,
    interactionRepository: interactions,
    probeService: probes,
  });
  projectId = knowledge.resolveProject({ path: '/srv/probe-project', machine: 'probe-box' }).id;
  bridgeToken = auth.createMachineToken({
    subject_id: 'probe-bridge', role: 'bridge', project_ids: [projectId],
  }).token;
  adminToken = auth.createMachineToken({ subject_id: 'probe-admin', role: 'admin' }).token;
  const app = createCoreServer({
    config: {}, authRepository: auth, taskRepository: tasks,
    interactionRepository: interactions, workersRegistry: workers, bridgeService,
    knowledgeRepository: knowledge, probeService: probes,
  });
  server = await app.listen({ host: '127.0.0.1', port: 0, tls: null });
  base = `http://127.0.0.1:${server.address().port}`;
  await registerBridge();
});

after(() => {
  server.close();
  knowledge.close();
  coreDatabase.close();
  auth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a probe is delivered on the executor pull and answered with evidence', async () => {
  const created = await call('/api/v1/probe', {
    body: { probe_id: 'probe-login', project_id: projectId, question: '登录功能完成了吗', budget_ms: 60000 },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.created, true);
  assert.equal(created.body.probe.state, 'queued');

  const pulled = await pull();
  assert.equal(pulled.status, 200);
  const delivered = pulled.body.probes.filter((probe) => probe.probeId === 'probe-login');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].state, 'claimed');
  assert.equal(delivered[0].question, '登录功能完成了吗');

  // A probe must never enter the task or claim path.
  assert.equal(tasks.list({ limit: 10 }).length, 0);
  assert.equal(pulled.body.claims.length, 0);

  const answered = await call('/api/v1/probe/probe-login/result', {
    token: bridgeToken,
    body: {
      verdict: 'done',
      confidence: 0.9,
      evidence: [{ kind: 'commit', ref: 'a41f9c2', observed_at: new Date().toISOString() }],
      suggested_reply: '已完成，版本 v1.4.2',
    },
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.probe.state, 'answered');
  assert.equal(answered.body.probe.verdict, 'done');
  assert.equal(answered.body.probe.evidence[0].ref, 'a41f9c2');

  // A second pull must not re-deliver an answered probe.
  const second = await pull();
  assert.equal(second.body.probes.length, 0);
});

test('re-requesting a known probe_id returns the existing record', async () => {
  const again = await call('/api/v1/probe', {
    body: { probe_id: 'probe-login', project_id: projectId, question: '不同的问题' },
  });
  assert.equal(again.body.created, false);
  assert.equal(again.body.probe.question, '登录功能完成了吗');
});

test('a public claim without evidence is refused, but unknown needs none', async () => {
  await call('/api/v1/probe', {
    body: { probe_id: 'probe-guard', project_id: projectId, question: '构建通过了吗' },
  });
  await pull();

  const bare = await call('/api/v1/probe/probe-guard/result', {
    token: bridgeToken,
    body: { verdict: 'done' },
  });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.code, 'evidence_required');

  const unknown = await call('/api/v1/probe/probe-guard/result', {
    token: bridgeToken,
    body: { verdict: 'unknown' },
  });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.probe.verdict, 'unknown');
});

test('an unanswered probe past its deadline expires instead of guessing', async () => {
  const created = await call('/api/v1/probe', {
    body: { probe_id: 'probe-stale', project_id: projectId, question: '还在跑吗', budget_ms: 1000 },
  });
  assert.equal(created.body.probe.state, 'queued');

  // Move the deadline into the past the way time would.
  coreDatabase.db.prepare('UPDATE probes SET deadline_at = ? WHERE probe_id = ?')
    .run('2000-01-01T00:00:00.000Z', 'probe-stale');

  const read = await call('/api/v1/probe/probe-stale', { method: 'GET' });
  assert.equal(read.status, 200);
  const pulled = await pull();
  assert.equal(pulled.body.probes.filter((probe) => probe.probeId === 'probe-stale').length, 0);
  const afterExpiry = await call('/api/v1/probe/probe-stale', { method: 'GET' });
  assert.equal(afterExpiry.body.probe.state, 'expired');
  assert.equal(afterExpiry.body.probe.verdict, null);
});

test('probe routes reject an unknown project and a missing probe', async () => {
  const missingProject = await call('/api/v1/probe', {
    body: { project_id: 'no-such-project', question: 'x' },
  });
  assert.equal(missingProject.status, 404);
  assert.equal(missingProject.body.code, 'PROJECT_NOT_FOUND');

  const missingProbe = await call('/api/v1/probe/probe-does-not-exist', { method: 'GET' });
  assert.equal(missingProbe.status, 404);
  assert.equal(missingProbe.body.code, 'probe_not_found');
});
