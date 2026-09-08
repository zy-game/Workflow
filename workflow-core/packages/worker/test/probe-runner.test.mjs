// probe-runner.test.mjs - the executor side of a probe. It is bounded,
// read-only, and always answers: a backend that cannot produce an
// evidence-backed verdict reports "unknown" rather than guessing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendRegistry } from '../src/backend-registry.js';
import { ProbeRunner } from '../src/probe-runner.js';

function fakeCore() {
  const sent = [];
  return { sent, send: (type, payload) => { sent.push({ type, payload }); return true; } };
}

function runnerFor(backend, options = {}) {
  const registry = new BackendRegistry({});
  registry.register('stub', { run: async () => ({ kind: 'done' }), ...backend }, { kind: 'stub', capabilities: [] });
  const core = fakeCore();
  return { core, runner: new ProbeRunner({ core, backendRegistry: registry, ...options }) };
}

const request = { probe_id: 'probe-1', project_id: 'default', question: '完成了吗', budget_ms: 1000 };

test('an evidence-backed verdict is forwarded verbatim', async () => {
  const { core, runner } = runnerFor({
    investigate: async ({ question, refs }) => ({
      verdict: 'done',
      confidence: 0.8,
      evidence: [{ kind: 'commit', ref: 'a41f9c2' }],
      suggestedReply: `已确认：${question}（refs=${refs.length}）`,
    }),
  });
  await runner.handle({ ...request, refs: [{ type: 'commit', value: 'a41f9c2' }] });
  assert.equal(core.sent.length, 1);
  assert.equal(core.sent[0].type, 'probe_result');
  assert.equal(core.sent[0].payload.probe_id, 'probe-1');
  assert.equal(core.sent[0].payload.verdict, 'done');
  assert.equal(core.sent[0].payload.confidence, 0.8);
  assert.equal(core.sent[0].payload.evidence[0].ref, 'a41f9c2');
  assert.match(core.sent[0].payload.suggested_reply, /已确认/);
});

test('a backend without investigate reports unknown', async () => {
  const { core, runner } = runnerFor({});
  await runner.handle(request);
  assert.equal(core.sent[0].payload.verdict, 'unknown');
  assert.deepEqual(core.sent[0].payload.evidence, []);
});

test('an unsupported verdict is normalized to unknown', async () => {
  const { core, runner } = runnerFor({ investigate: async () => ({ verdict: 'probably' }) });
  await runner.handle(request);
  assert.equal(core.sent[0].payload.verdict, 'unknown');
});

test('a failing investigation answers unknown instead of propagating', async () => {
  const { core, runner } = runnerFor({ investigate: async () => { throw new Error('boom'); } });
  await runner.handle(request);
  assert.equal(core.sent.length, 1);
  assert.equal(core.sent[0].payload.verdict, 'unknown');
});

test('an investigation that outlives the budget is aborted and answers unknown', async () => {
  let aborted = false;
  const { core, runner } = runnerFor({
    investigate: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }),
  });
  await runner.handle({ ...request, budget_ms: 1000 });
  assert.equal(aborted, true);
  assert.equal(core.sent[0].payload.verdict, 'unknown');
});

test('work beyond the concurrency limit answers unknown instead of queueing', async () => {
  let release;
  const { core, runner } = runnerFor({
    investigate: () => new Promise((resolve) => { release = resolve; }),
  }, { maxConcurrent: 1 });
  const first = runner.handle({ ...request, probe_id: 'probe-a' });
  await runner.handle({ ...request, probe_id: 'probe-b' });
  assert.equal(core.sent[0].payload.probe_id, 'probe-b');
  assert.equal(core.sent[0].payload.verdict, 'unknown');
  release({ verdict: 'done', evidence: [{ kind: 'x', ref: 'y' }] });
  await first;
  assert.equal(core.sent[1].payload.probe_id, 'probe-a');
  assert.equal(core.sent[1].payload.verdict, 'done');
});
