import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { BackendRegistry } from '../src/backend-registry.js';
import { InteractionBridge } from '../src/interaction-bridge.js';
import { recoverPendingRuns } from '../src/index.js';
import { RunStore } from '../src/run-store.js';
import { TaskRunner } from '../src/runner.js';

const dirs = [];
const stores = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness({ resume = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-runner-'));
  dirs.push(dir);
  const runStore = new RunStore({ dataDir: dir });
  stores.push(runStore);
  const ackHandlers = new Set();
  const sent = [];
  const core = {
    send(type, payload, options = {}) {
      const id = options.id ?? `frame-${sent.length}`;
      sent.push({ type, payload, id });
      return true;
    },
    onAck(handler) { ackHandlers.add(handler); return () => ackHandlers.delete(handler); },
  };
  const registry = new BackendRegistry({ log: () => {} });
  registry.register('workflow-jsonl', {
    run: async ({ progress, emit }) => {
      progress('started', 0);
      emit?.({ type: 'assistant_message', text: 'working' });
      return { kind: 'done', result: { summary: 'ok' } };
    },
    ...(resume ? { resume: async () => ({ kind: 'done', result: { summary: 'resumed' } }) } : {}),
  }, { kind: 'workflow-jsonl', capabilities: ['run', 'resume', 'interaction'], version: '1' });
  const runner = new TaskRunner({ core, backendRegistry: registry, runStore, log: () => {} });
  return { runStore, sent, ackHandlers, runner };
}

function task(overrides = {}) {
  return {
    task_id: 'task-1', claim_token: 'claim-1', backend_kind: 'workflow-jsonl',
    brief: { goal: 'run the suite' }, ...overrides,
  };
}

test('terminal runs stay completion_pending until the terminal frame is acknowledged', async () => {
  const { runStore, sent, ackHandlers, runner } = harness();
  await runner.handleDispatch(task());
  const run = runStore.get('task-1');
  assert.equal(run.phase, 'completion_pending');
  assert.ok(run.terminalFrameId);
  const terminal = sent.find((frame) => frame.id === run.terminalFrameId);
  assert.equal(terminal.type, 'task_done');
  assert.equal(terminal.payload.kind, 'done');
  assert.equal(run.result.summary, 'ok');
  for (const handler of ackHandlers) handler(run.terminalFrameId, { accepted: true });
  assert.equal(runStore.get('task-1'), null);
});

test('interaction_required persists awaiting_input phase and interaction id until resolved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-runner-'));
  dirs.push(dir);
  const store = new RunStore({ dataDir: dir });
  stores.push(store);
  const sent = [];
  const core = {
    send(type, payload, options = {}) { const id = options.id ?? `frame-${sent.length}`; sent.push({ type, payload, id }); return true; },
    onAck() { return () => {}; },
  };
  const registry = new BackendRegistry({ log: () => {} });
  let resolveRun;
  const runPromise = new Promise((resolve) => { resolveRun = resolve; });
  registry.register('workflow-jsonl', {
    run: async ({ emit }) => {
      emit({ type: 'interaction_required', interaction: { interaction_id: 'inter-1', kind: 'question', schema: { prompt: 'pick' } } });
      return runPromise;
    },
    resolveInteraction: async ({ response }) => { resolveRun({ kind: 'done', result: { summary: response.answers?.choice ?? 'answered' } }); return true; },
  }, { kind: 'workflow-jsonl', capabilities: ['run', 'interaction'], version: '1' });
  const bridge = new InteractionBridge({ core, backendRegistry: registry, log: () => {} });
  const runner = new TaskRunner({ core, backendRegistry: registry, runStore: store, interactionBridge: bridge, log: () => {} });
  const dispatch = runner.handleDispatch(task());
  await new Promise((resolve) => setImmediate(resolve));
  const during = store.get('task-1');
  assert.equal(during.phase, 'awaiting_input');
  assert.equal(during.interactionId, 'inter-1');
  await runner.handleInteractionResponse({
    task_id: 'task-1', interaction_id: 'inter-1',
    response: { response_id: 'r1', answers: { choice: 'suite green' } },
  });
  const ok = await dispatch;
  assert.equal(ok, true);
  const done = store.get('task-1');
  assert.equal(done.phase, 'completion_pending');
  assert.ok(done.terminalFrameId);
  const terminal = sent.find((frame) => frame.id === done.terminalFrameId);
  assert.equal(terminal.type, 'task_done');
  assert.equal(terminal.payload.result.summary, 'suite green');
});

test('resumed dispatch without a matching local run fails closed with a stable terminal frame', async () => {
  const { runStore, sent, runner } = harness({ resume: true });
  const ok = await runner.handleDispatch(task({ task_id: 'task-2', claim_token: 'claim-2' }), { resumed: true });
  assert.equal(ok, false);
  const run = runStore.get('task-2');
  assert.equal(run.phase, 'completion_pending');
  assert.ok(run.terminalFrameId);
  const terminal = sent.find((frame) => frame.id === run.terminalFrameId);
  assert.equal(terminal.type, 'task_failed');
  assert.match(terminal.payload.result.error, /no matching local run/);
});

test('awaiting_input runs fail closed instead of resuming a lost backend session', async () => {
  const { runStore, sent, runner } = harness({ resume: true });
  const taskValue = task({ task_id: 'task-3', claim_token: 'claim-3', session_ref: 'sess-1' });
  runStore.put({ taskId: 'task-3', claimToken: 'claim-3', backendKind: 'workflow-jsonl', sessionRef: 'sess-1', phase: 'awaiting_input', interactionId: 'inter-3' });
  const ok = await runner.handleDispatch(taskValue, { resumed: true });
  assert.equal(ok, false);
  const run = runStore.get('task-3');
  assert.equal(run.phase, 'completion_pending');
  const terminal = sent.find((frame) => frame.id === run.terminalFrameId);
  assert.equal(terminal.type, 'task_failed');
  assert.match(terminal.payload.result.error, /awaited local input/);
});

test('startup recovery drops acknowledged terminal runs and keeps unacknowledged ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-recover-'));
  dirs.push(dir);
  const store = new RunStore({ dataDir: dir });
  stores.push(store);
  store.put({ taskId: 'acked', claimToken: 'c', backendKind: 'workflow-jsonl', phase: 'completion_pending', result: { ok: true }, terminalFrameId: 'gone-frame' });
  store.enqueue({ frameId: 'pending-frame', type: 'task_done', payload: { task_id: 'pending', claim_token: 'c' } });
  store.put({ taskId: 'pending', claimToken: 'c', backendKind: 'workflow-jsonl', phase: 'completion_pending', result: { ok: true }, terminalFrameId: 'pending-frame' });
  store.put({ taskId: 'running', claimToken: 'c', backendKind: 'workflow-jsonl', phase: 'running', sessionRef: 'sess-1' });
  const { dropped, kept } = recoverPendingRuns({ runStore: store });
  assert.equal(dropped, 1);
  assert.equal(kept, 1);
  assert.equal(store.get('acked'), null);
  assert.equal(store.get('pending').phase, 'completion_pending');
  assert.equal(store.get('running').phase, 'running');
});
