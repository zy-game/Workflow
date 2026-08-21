// worker-daemon.test.mjs - full-stack M3 acceptance: the real worker daemon
// against the real core server, with a fake local DSH standing in for the
// harness. Verifies register/model-apply/dispatch/stream/inject/cancel/done
// over the wire with no mocks inside either process boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { AuthRepository } from '../../core/src/auth/repository.js';
import { CoreDatabase } from '../../core/src/db/core-db.js';
import { TaskRepository } from '../../core/src/tasks/repository.js';
import { WorkersRegistry } from '../../core/src/workers/registry.js';
import { ModelRegistry } from '../../core/src/models/registry.js';
import { ApprovalRegistry } from '../../core/src/approvals/registry.js';
import { createWorkerChannel } from '../../core/src/ws/channel.js';
import { createCoreServer } from '../../core/src/http/server.js';
import { startWorker, loadWorkerConfig, buildDshChildEnv } from '../src/index.js';

// --- fake local DSH: minimal wire contract the worker relies on -----------
function startFakeDsh() {
  const state = {
    sessions: new Map(),
    credentials: [],
    mutations: [],
    prompts: [],
    cancelled: [],
    responded: [],
    muxClients: new Set(),
    sequence: 0,
    failCredentialSet: false,
  };
  const broadcast = (payload, rpcId = 'mux-rpc') => {
    const frame = JSON.stringify({ rpcId, payload });
    for (const client of state.muxClients) client.send(frame);
  };
  const handle = (req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      // /api/respond carries a client-response envelope, not client-request.
      if (req.url.endsWith('/api/respond')) {
        const response = JSON.parse(raw);
        const value = response?.result?.value ?? {};
        state.responded.push({ rpcId: response.rpcId, ...value });
        broadcast({ type: 'approval/resolved', sessionId: value.sessionId, approvalId: value.approvalId, outcome: value.outcome });
        const session = state.sessions.get(value.sessionId);
        if (session) {
          setTimeout(() => {
            session.events.push({ event: { seq: session.events.length, type: 'tool/call', data: { tool: 'shell', args: { cmd: 'npm test' } } } });
            session.events.push({ event: { seq: session.events.length, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: `approved path executed (${value.outcome})` }] } } } });
            session.events.push({ event: { seq: session.events.length, type: 'turn/end', data: { reason: { kind: 'completed' } } } });
          }, 20);
        }
        return res.end(JSON.stringify({ accepted: true }));
      }
      const envelope = JSON.parse(raw);
      const { method, payload } = envelope;
      const ok = (value) => res.end(JSON.stringify({
        type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value },
      }));
      if (method === 'host.describe') return ok({ version: 'fake' });
      if (method === 'llm.providers') return ok({ providers: [
        { provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] },
      ] });
      if (method === 'settings.describe') return ok({ writable: true, namespaces: [
        { ns: 'llm-deepseek', revision: 0, value: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-v4-flash' }] } },
        { ns: 'agent-default-model', revision: 0, value: { provider: 'other', model: 'other-model' } },
      ] });
      if (method === 'credentials.set') {
        if (state.failCredentialSet) {
          return res.end(JSON.stringify({
            type: 'server-response', rpcId: envelope.rpcId,
            result: { ok: false, error: { code: 'credential-rejected', message: 'write rejected' } },
          }));
        }
        state.credentials.push(payload);
        return ok({ stored: true });
      }
      if (method === 'settings.mutate') { state.mutations.push(payload); return ok({ revision: 1 }); }
      if (method === 'session.create') {
        const sessionId = `s-${++state.sequence}`;
        state.sessions.set(sessionId, { events: [], workspace: payload.cwd });
        return ok({ sessionId, id: sessionId });
      }
      if (method === 'session.prompt') {
        const session = state.sessions.get(payload.sessionId);
        const text = payload.content?.[0]?.text ?? '';
        state.prompts.push({ sessionId: payload.sessionId, text });
        if (!session) return res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code: 'not_found', message: 'no session' } } }));
        const emit = (type, data, afterMs) => setTimeout(() => {
          session.events.push({ event: { seq: session.events.length, type, data } });
        }, afterMs);
        // Sessions created for "slow" goals stay open until cancelled - lets
        // tests inject mid-run (including follow-up prompts).
        if (session.hold === undefined) session.hold = text.includes('slow task');
        if (session.hold) return ok({ queued: true });
        // Interrupt sessions model a DSH process death: the first turn ends
        // interrupted; a continuation prompt then completes the work.
        if (session.interruptible === undefined) session.interruptible = text.includes('interrupt-turn');
        if (session.interruptible) {
          const promptsHere = state.prompts.filter((entry) => entry.sessionId === payload.sessionId).length;
          if (promptsHere === 1) {
            emit('user/message', {
              content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'u1',
            }, 10);
            emit('turn/end', { reason: { kind: 'interrupted' } }, 30);
            return ok({ queued: true });
          }
          emit('assistant/message', {
            turn: 2, step: 1,
            message: { role: 'assistant', content: [{ type: 'text', text: 'resumed after interruption: work complete' }] },
            usage: {},
          }, 20);
          emit('turn/end', { reason: { kind: 'completed' } }, 30);
          return ok({ queued: true });
        }
        // Two-turn sessions model a queued injection: the first turn keeps
        // running until the injection arrives, then ends, and the injected
        // prompt drives a second turn before the session goes idle.
        if (session.twoTurn === undefined) session.twoTurn = text.includes('two-turn');
        if (session.twoTurn) {
          const promptsHere = state.prompts.filter((entry) => entry.sessionId === payload.sessionId).length;
          if (promptsHere >= 2) {
            emit('turn/end', { reason: 'stop' }, 10);
            emit('user/message', {
              content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'u-inject',
            }, 20);
            emit('assistant/message', {
              turn: 2, step: 1,
              message: { role: 'assistant', content: [{ type: 'text', text: `corrected: ${text.slice(0, 20)}` }] },
              usage: {},
            }, 30);
            emit('turn/end', { reason: 'stop' }, 40);
          }
          return ok({ queued: true });
        }
        // Approval sessions block mid-turn: the ask is pushed on the mux
        // websocket and the turn only continues after /api/respond.
        if (session.approvalFlow === undefined) session.approvalFlow = text.includes('approval task');
        if (session.approvalFlow && !session.approvalSent) {
          session.approvalSent = true;
          emit('user/message', {
            content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'u1',
          }, 10);
          setTimeout(() => {
            broadcast({
              type: 'approval/requested', sessionId: payload.sessionId,
              approvalId: 'dsh-ap-1', toolName: 'shell', reason: 'run npm test in workspace',
            }, 'rpc-dsh-1');
          }, 20);
          return ok({ queued: true });
        }
        emit('user/message', {
          content: [{ type: 'text', text: text.slice(0, 40) }],
          source: { kind: 'user' }, role: 'user', id: 'u1',
        }, 10);
        // Real DSH streams chunk events before the final assembled message,
        // whose content is a typed part array (reasoning + text parts).
        emit('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'working' } }, 20);
        emit('assistant/message', {
          turn: 1, step: 1,
          message: { role: 'assistant', content: [
            { type: 'reasoning', text: 'internal reasoning is not part of summaries' },
            { type: 'text', text: `working on: ${text.slice(0, 30)}` },
          ] },
          usage: {},
        }, 30);
        emit('tool/call', { tool: 'shell', args: { cmd: 'npm test' } }, 50);
        emit('turn/end', { reason: 'stop' }, 70);
        return ok({ queued: true });
      }
      if (method === 'session.cancel') {
        state.cancelled.push(payload.sessionId);
        const session = state.sessions.get(payload.sessionId);
        if (session) session.events.push({ event: { seq: session.events.length, type: 'turn/end', data: { reason: 'cancelled' } } });
        return ok({ cancelled: true });
      }
      if (method === 'session.history') {
        const session = state.sessions.get(payload.sessionId);
        if (!session) return res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code: 'not_found', message: 'no session' } } }));
        let events = session.events.map((entry) => ({ ...entry }));
        if (Number.isSafeInteger(payload.beforeSeq)) {
          events = events.filter((entry) => entry.event.seq < payload.beforeSeq);
        }
        events.sort((a, b) => b.event.seq - a.event.seq);
        const limit = Math.min(payload.maxMessages ?? 100, events.length);
        const page = events.slice(0, limit).reverse();
        return ok({ header: { id: payload.sessionId, cwd: session.workspace }, events: page, hasMore: events.length > limit });
      }
      return res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code: 'unknown', message: method } } }));
    });
  };
  const server = http.createServer(handle);
  const mux = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.includes('/api/events.mux')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    mux.handleUpgrade(req, socket, head, (ws) => {
      state.muxClients.add(ws);
      ws.on('close', () => state.muxClients.delete(ws));
    });
  });
  return { server, state };
}

let dir;
let auth;
let coreDb;
let channel;
let server;
let base;
let adminToken;
let workerToken;
let fakeDsh;
let worker;
let workerLogs;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-m3-'));
  auth = new AuthRepository({ dataDir: dir });
  await auth.createAccount({ email: 'owner@example.com', password: 'correct-horse-battery' });
  coreDb = new CoreDatabase({ dataDir: dir });
  const tasks = new TaskRepository({ coreDb, claimTimeoutMs: 60_000 });
  const workers = new WorkersRegistry({ coreDb });
  const models = new ModelRegistry({ coreDb });
  const approvalsRegistry = new ApprovalRegistry({ coreDb });
  channel = createWorkerChannel({ authRepository: auth, taskRepository: tasks, workersRegistry: workers, modelRegistry: models, approvalsRegistry });
  const core = createCoreServer({ authRepository: auth, taskRepository: tasks, workersRegistry: workers, modelRegistry: models, workerChannel: channel });
  server = await core.listen({ host: '127.0.0.1', port: 0, tls: null });
  channel.handleUpgrade(server);
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/v1/auth/client-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }),
  }).then((response) => response.json());
  adminToken = login.access_token;
  const issued = await fetch(`${base}/api/v1/admin/tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subject_id: 'win-dev', role: 'worker' }),
  }).then((response) => response.json());
  workerToken = issued.token;

  fakeDsh = startFakeDsh();
  await new Promise((resolve) => fakeDsh.server.listen(0, '127.0.0.1', resolve));

  const config = loadWorkerConfig({
    WFC_CORE_URL: base,
    WFC_WORKER_TOKEN: workerToken,
    WFC_WORKER_ID: 'win-dev',
    WFC_WORKER_CAPABILITIES: 'dsh',
    WFC_DSH_ENDPOINT: `http://127.0.0.1:${fakeDsh.server.address().port}`,
    WFC_WORKER_STATE_DIR: dir,
    WFC_WORKER_WORKSPACE: 'E:/tmp-workspace',
  });
  workerLogs = [];
  worker = await startWorker(config, { log: (line) => workerLogs.push(line), pollMs: 60 });
});

after(async () => {
  await worker.stop();
  channel.stop();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => fakeDsh.server.close(resolve));
  auth.close();
  coreDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function api(method, pathname, { token = adminToken, body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(predicate, label, timeoutMs = 8000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

test('worker daemon end-to-end: model apply, dispatch, stream, done', async () => {
  const workersList = await waitFor(async () => {
    const listed = await api('GET', '/api/v1/workers');
    return listed.body.workers.find((entry) => entry.worker_id === 'win-dev' && entry.connected);
  }, 'worker registered');
  assert.deepEqual(workersList.capabilities, ['dsh']);

  const modelAdded = await api('POST', '/api/v1/admin/models', {
    body: { provider: 'deepseek-official', model: 'deepseek-v4-flash', key: 'sk-worker-push', baseUrl: 'https://api.deepseek.com', priority: 0 },
  });
  assert.equal(modelAdded.status, 200);
  await waitFor(() => fakeDsh.state.credentials.some((call) => call.ref === 'DEEPSEEK_API_KEY' && call.value === 'sk-worker-push'), 'models applied to local DSH');
  assert.ok(fakeDsh.state.mutations.some((call) => call.ns === 'agent-default-model'
    && call.ops.some((op) => op.path[0] === 'provider' && op.value === 'deepseek-official')));
  await waitFor(async () => {
    const listed = await api('GET', '/api/v1/workers');
    const entry = listed.body.workers.find((item) => item.worker_id === 'win-dev');
    return entry?.last_models_revision !== null && entry.last_models_revision >= 1;
  }, 'models_ack recorded');

  const created = await api('POST', '/api/v1/tasks', {
    body: {
      type: 'dsh.run',
      brief: { goal: 'ship the feature', acceptance: ['tests pass'], workspace: 'E:/proj-a' },
    },
  });
  assert.equal(created.status, 200);
  const taskId = created.body.task.task_id;

  await waitFor(async () => fakeDsh.state.prompts.some((entry) => entry.text.includes('ship the feature')), 'task prompted into local DSH');
  const done = await waitFor(async () => {
    const state = await api('GET', `/api/v1/tasks/${taskId}`);
    return state.body.task.status === 'done' ? state.body.task : null;
  }, 'task done');
  assert.match(done.result.summary, /working on:/);
  assert.equal(done.result.export.format, 'dsh-logical-session-v1');

  const events = await api('GET', `/api/v1/tasks/${taskId}/events`);
  const sessionEvents = events.body.events.filter((event) => event.type === 'session_event');
  assert.ok(sessionEvents.some((event) => event.payload.event?.type === 'tool/call'));
  assert.ok(sessionEvents.some((event) => event.payload.event?.type === 'assistant/message'));
  assert.ok(sessionEvents.every((event) => !JSON.stringify(event).includes('sk-worker-push')), 'no key material in events');
});

test('failed model apply reports an error without acknowledging the revision', async () => {
  const before = await api('GET', '/api/v1/workers');
  const priorRevision = before.body.workers.find((entry) => entry.worker_id === 'win-dev').last_models_revision;
  fakeDsh.state.failCredentialSet = true;
  const rejectedKey = 'sk-never-log-this-value';
  try {
    const added = await api('POST', '/api/v1/admin/models', {
      body: {
        provider: 'deepseek-official', model: 'deepseek-v4-pro', key: rejectedKey,
        baseUrl: 'https://api.deepseek.com', priority: 1,
      },
    });
    assert.equal(added.status, 200);
    await waitFor(() => workerLogs.some((line) => line.includes('credentials.set credential-rejected')), 'model failure log');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterFailure = await api('GET', '/api/v1/workers');
    assert.equal(
      afterFailure.body.workers.find((entry) => entry.worker_id === 'win-dev').last_models_revision,
      priorRevision,
    );
    assert.ok(workerLogs.every((line) => !line.includes(rejectedKey)));
  } finally {
    fakeDsh.state.failCredentialSet = false;
  }
});

test('inject reaches the running session; cancel stops it', async () => {
  const created = await api('POST', '/api/v1/tasks', {
    body: { type: 'dsh.run', brief: { goal: 'slow task' } },
  });
  const taskId = created.body.task.task_id;
  await waitFor(() => fakeDsh.state.prompts.some((entry) => entry.text.includes('slow task')), 'first prompt');

  const injected = await api('POST', `/api/v1/tasks/${taskId}/inject`, {
    body: { content: 'switch to plan B' },
  });
  assert.equal(injected.body.ok, true);
  await waitFor(() => fakeDsh.state.prompts.some((entry) => entry.text.includes('switch to plan B')), 'injected prompt');

  const cancelled = await api('POST', `/api/v1/tasks/${taskId}/cancel`);
  assert.equal(cancelled.status, 200);
  await waitFor(() => fakeDsh.state.cancelled.length > 0, 'session cancelled in local DSH');
});

test('queued injection delays completion until its turn ends', async () => {
  const created = await api('POST', '/api/v1/tasks', {
    body: { type: 'dsh.run', brief: { goal: 'two-turn task' } },
  });
  const taskId = created.body.task.task_id;
  await waitFor(() => fakeDsh.state.prompts.some((entry) => entry.text.includes('two-turn task')), 'first prompt');

  const injected = await api('POST', `/api/v1/tasks/${taskId}/inject`, {
    body: { content: 'switch to plan B' },
  });
  assert.equal(injected.body.ok, true);

  let task = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    task = (await api('GET', `/api/v1/tasks/${taskId}`)).body.task;
    if (['done', 'failed'].includes(task.status)) break;
  }
  assert.equal(task.status, 'done');
  assert.match(task.result.summary, /corrected: switch to plan B/);
  const events = (await api('GET', `/api/v1/tasks/${taskId}/events?limit=2000`)).body.events;
  const userTexts = events
    .filter((event) => event.type === 'session_event' && event.payload?.event?.type === 'user/message')
    .map((event) => JSON.stringify(event.payload.event.data));
  assert.ok(userTexts.some((text) => text.includes('switch to plan B')), 'injection visible in session events');
  const turnEnds = events.filter((event) => event.type === 'session_event' && event.payload?.event?.type === 'turn/end');
  assert.equal(turnEnds.length, 2, 'both turns forwarded');
});

test('interrupted turn re-prompts the session once and completes with the continuation reply', async () => {
  const created = await api('POST', '/api/v1/tasks', {
    body: { type: 'dsh.run', brief: { goal: 'interrupt-turn task' } },
  });
  const taskId = created.body.task.task_id;
  let task = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    task = (await api('GET', `/api/v1/tasks/${taskId}`)).body.task;
    if (['done', 'failed'].includes(task.status)) break;
  }
  assert.equal(task.status, 'done');
  assert.match(task.result.summary, /resumed after interruption/);
  const prompts = fakeDsh.state.prompts
    .filter((entry) => entry.text.includes('interrupt-turn task') || entry.text.includes('任务因服务重启被中断'))
    .map((entry) => entry.text.slice(0, 24));
  assert.equal(prompts.length, 2, 'original prompt plus one continuation');
  assert.ok(prompts[0].startsWith('目标：'), 'original prompt sent first');
  assert.ok(prompts[1].includes('任务因服务重启被中断'), 'continuation prompt, not a replay');
  const events = (await api('GET', `/api/v1/tasks/${taskId}/events?limit=2000`)).body.events;
  const turnEnds = events.filter((event) => event.type === 'session_event' && event.payload?.event?.type === 'turn/end');
  assert.equal(turnEnds.length, 2, 'both turn ends forwarded');
});

test('approval blocks the turn, resolves via admin API, and answers the local DSH', async () => {
  const created = await api('POST', '/api/v1/tasks', {
    body: { type: 'dsh.run', brief: { goal: 'approval task: needs permission' } },
  });
  const taskId = created.body.task.task_id;

  let pending = null;
  for (let attempt = 0; attempt < 50 && !pending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const list = await api('GET', '/api/v1/admin/approvals?task_id=' + taskId);
    pending = list.body.approvals[0] ?? null;
  }
  assert.ok(pending, 'approval surfaced to the admin API');
  assert.equal(pending.tool, 'shell');
  assert.equal(pending.dsh_approval_id, 'dsh-ap-1');
  assert.equal(pending.dsh_rpc_id, 'rpc-dsh-1');
  assert.equal(pending.task_status, 'running');

  const resolved = await api('POST', `/api/v1/admin/approvals/${pending.approval_id}/resolve`, {
    body: { decision: 'approve' },
  });
  assert.equal(resolved.body.ok, true);

  let respond = null;
  for (let attempt = 0; attempt < 50 && !respond; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    respond = fakeDsh.state.responded[0] ?? null;
  }
  assert.ok(respond, 'worker answered the local DSH approval');
  assert.equal(respond.rpcId, 'rpc-dsh-1');
  assert.equal(respond.approvalId, 'dsh-ap-1');
  assert.equal(respond.outcome, 'allowed-once');

  let task = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    task = (await api('GET', `/api/v1/tasks/${taskId}`)).body.task;
    if (['done', 'failed'].includes(task.status)) break;
  }
  assert.equal(task.status, 'done');
  assert.match(task.result.summary, /approved path executed/);

  const after = await api('GET', '/api/v1/admin/approvals?task_id=' + taskId);
  assert.equal(after.body.approvals.length, 0, 'resolved approval leaves the pending list');
});

test('worker restart resumes the same DSH session without repeating the prompt', async () => {
  const created = await api('POST', '/api/v1/tasks', {
    body: { type: 'dsh.run', brief: { goal: 'slow task for restart' } },
  });
  const taskId = created.body.task.task_id;
  await waitFor(() => fakeDsh.state.prompts.find((entry) => entry.text.includes('slow task for restart')), 'restart task prompt');
  const prompt = fakeDsh.state.prompts.find((entry) => entry.text.includes('slow task for restart'));
  const promptCount = fakeDsh.state.prompts.length;

  await worker.stop();
  const config = loadWorkerConfig({
    WFC_CORE_URL: base,
    WFC_WORKER_TOKEN: workerToken,
    WFC_WORKER_ID: 'win-dev',
    WFC_WORKER_CAPABILITIES: 'dsh',
    WFC_DSH_ENDPOINT: `http://127.0.0.1:${fakeDsh.server.address().port}`,
    WFC_WORKER_STATE_DIR: dir,
    WFC_WORKER_WORKSPACE: 'E:/tmp-workspace',
  });
  worker = await startWorker(config, { log: (line) => workerLogs.push(line), pollMs: 60 });

  await waitFor(async () => {
    const listed = await api('GET', '/api/v1/workers');
    return listed.body.workers.find((entry) => entry.worker_id === 'win-dev' && entry.connected);
  }, 'worker re-registered');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fakeDsh.state.prompts.length, promptCount);
  assert.equal(worker.stateStore.get(taskId).sessionId, prompt.sessionId);

  const cancelled = await api('POST', `/api/v1/tasks/${taskId}/cancel`);
  assert.equal(cancelled.status, 200);
  await waitFor(() => fakeDsh.state.cancelled.includes(prompt.sessionId), 'resumed session cancelled');
});

test('worker config supports the Node-backed DSH CLI entrypoint', () => {
  const config = loadWorkerConfig({
    WFC_CORE_URL: 'http://127.0.0.1:18710',
    WFC_WORKER_TOKEN: 'test-token',
    WFC_DSH_NODE: '/opt/node24/bin/node',
    WFC_DSH_BIN: '/opt/node24/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    WFC_DSH_HOME: '/var/lib/workflow-worker/dsh',
    WFC_WORKER_STATE_DIR: '/var/lib/workflow-worker',
  });
  assert.equal(config.dshNode, '/opt/node24/bin/node');
  assert.equal(config.dshBin, '/opt/node24/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
  assert.equal(config.dshHome, '/var/lib/workflow-worker/dsh');
  assert.equal(config.stateDir, '/var/lib/workflow-worker');
});

test('assistantText resolves real DSH message shapes and ignores chunk-only events', async () => {
  const { assistantText } = await import('../src/runner.js');
  assert.equal(assistantText({ type: 'assistant/message', data: { text: 'flat shape' } }), 'flat shape');
  assert.equal(assistantText({
    type: 'assistant/message',
    data: { message: { content: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer part one ' },
      { type: 'text', text: 'two' },
    ] } },
  }), 'answer part one two');
  assert.equal(assistantText({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'streaming' } } }), null);
  assert.equal(assistantText({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'only reasoning' }] } } }), null);
});

test('DSH child env pins every state path inside dshHome and strips the worker token', () => {  const config = loadWorkerConfig({
    WFC_CORE_URL: 'http://127.0.0.1:18710',
    WFC_WORKER_TOKEN: 'test-token',
    WFC_DSH_HOME: '/var/lib/workflow-worker/dsh',
  });
  const childEnv = buildDshChildEnv(config, {
    ...process.env,
    WFC_WORKER_TOKEN: 'test-token',
    HOME: '/home/ubuntu',
    DSH_SESSION_DB: '/home/ubuntu/.dsh/sessions.db',
  });
  assert.equal(childEnv.WFC_WORKER_TOKEN, undefined);
  assert.equal(childEnv.HOME, '/var/lib/workflow-worker/dsh');
  assert.equal(childEnv.DSH_HOME, '/var/lib/workflow-worker/dsh/.dsh');
  assert.equal(childEnv.DSH_SESSION_DB, '/var/lib/workflow-worker/dsh/.dsh/sessions.db');
  assert.equal(childEnv.DSH_STATE_DB, '/var/lib/workflow-worker/dsh/.dsh/dsh-state.db');
  assert.equal(childEnv.DSH_SESSION_QUERY_DB, '/var/lib/workflow-worker/dsh/.dsh/session-query.db');

  const sharedless = buildDshChildEnv(loadWorkerConfig({
    WFC_CORE_URL: 'http://127.0.0.1:18710',
    WFC_WORKER_TOKEN: 'test-token',
  }));
  assert.equal(sharedless.WFC_WORKER_TOKEN, undefined);
  assert.equal(sharedless.DSH_HOME, undefined);
  assert.equal(sharedless.DSH_SESSION_DB, undefined);
});
