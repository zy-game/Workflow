import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { TaskRepository } from '../src/tasks/repository.js';

let dir;
let repo;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-tasks-'));
  repo = new TaskRepository({ dataDir: dir, claimTimeoutMs: 100 });
});

after(() => {
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Every test tags its tasks with a unique selector so claims stay isolated
// from leftovers of other tests (an untagged task would match any claim).
function makeTask(tag, overrides = {}) {
  const { worker_selector, ...rest } = overrides;
  return repo.create({
    type: 'workflow.run',
    brief: { goal: 'do the thing', acceptance: ['it is done'] },
    created_by: 'account:owner',
    ...rest,
    worker_selector: worker_selector ?? { tag },
  }).task;
}

function claimTag(tag, worker = 'machine:w1', overrides = {}) {
  return repo.claim({
    worker_id: worker,
    selector: { tag },
    capabilities: [],
    backends: [{ kind: 'workflow-jsonl', capabilities: [] }],
    ...overrides,
  });
}

test('normalizes default routing to the origin node and blocks other nodes', () => {
  const originRepo = new TaskRepository({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-route-origin-')), nodeId: 'node-origin' });
  try {
    const task = originRepo.create({ type: 'workflow.run', brief: { goal: 'route' }, created_by: 'account:owner', worker_selector: { tag: 'route-default' } }).task;
    assert.equal(task.project_id, 'default');
    assert.equal(task.origin_node_id, 'node-origin');
    assert.equal(task.executor_node_id, 'node-origin');
    assert.deepEqual(task.execution_policy_snapshot, {
      project_id: 'default', origin_node_id: 'node-origin', executor_node_id: 'node-origin',
    });
    assert.equal(originRepo.claim({ worker_id: 'machine:other', node_id: 'node-other', selector: { tag: 'route-default' }, capabilities: [], backends: [{ kind: 'workflow-jsonl', capabilities: [] }] }), null);
    assert.equal(originRepo.get(task.task_id).status, 'queued');
    assert.ok(originRepo.claim({ worker_id: 'machine:origin', node_id: 'node-origin', selector: { tag: 'route-default' }, capabilities: [], backends: [{ kind: 'workflow-jsonl', capabilities: [] }] }));
  } finally {
    const routeDir = originRepo.coreDatabase?.file ? path.dirname(originRepo.coreDatabase.file) : null;
    originRepo.close();
    if (routeDir) fs.rmSync(routeDir, { recursive: true, force: true });
  }
});

test('preserves explicit project executor in the task policy snapshot', () => {
  const task = makeTask('route-project', {
    project_id: 'project-one', origin_node_id: 'node-origin', executor_node_id: 'node-owner',
    execution_policy: { mode: 'project-owner' },
  });
  assert.equal(task.project_id, 'project-one');
  assert.equal(task.executor_node_id, 'node-owner');
  assert.equal(task.execution_policy_snapshot.mode, 'project-owner');
  assert.equal(task.execution_policy_snapshot.executor_node_id, 'node-owner');
  assert.equal(claimTag('route-project', 'machine:wrong', { node_id: 'node-wrong' }), null);
  assert.equal(repo.get(task.task_id).status, 'queued');
  assert.ok(claimTag('route-project', 'machine:owner', { node_id: 'node-owner' }));
});

test('creates tasks with defaults and records the creation event', () => {
  const task = makeTask('create');
  assert.equal(task.status, 'queued');
  assert.equal(task.priority, 5);
  assert.equal(task.attempts, 0);
  const events = repo.events(task.task_id);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'created');
});

test('idempotency keys replay the original task instead of duplicating', () => {
  const first = repo.create({
    type: 'feishu.reply', brief: { message: 'hi' }, created_by: 'machine:feishu', idempotency_key: 'msg-1',
    worker_selector: { tag: 'idem' },
  });
  const second = repo.create({
    type: 'feishu.reply', brief: { message: 'hi' }, created_by: 'machine:feishu', idempotency_key: 'msg-1',
    worker_selector: { tag: 'idem' },
  });
  assert.equal(second.idempotent_replay, true);
  assert.equal(second.task.task_id, first.task.task_id);
  const other = repo.create({
    type: 'feishu.reply', brief: { message: 'hi' }, created_by: 'machine:other', idempotency_key: 'msg-1',
    worker_selector: { tag: 'idem' },
  });
  assert.equal(other.idempotent_replay, false);
});

test('Core rejects Worker-local workspace paths in task payloads', () => {
  assert.throws(
    () => makeTask('workspace-top', { workspace: 'E:/private/project' }),
    /Worker-local/,
  );
  assert.throws(
    () => makeTask('workspace-brief', { brief: { goal: 'do it', workspace: '/private/project' } }),
    /Worker-local/,
  );
});

test('unknown dependencies are rejected at creation', () => {
  assert.throws(() => makeTask('baddep', { dependencies: ['t-missing'] }), /dependency does not exist/);
});

test('claim respects priority ordering and attaches a lease', () => {
  const low = makeTask('prio', { priority: 8 });
  const high = makeTask('prio', { priority: 1 });
  const claimedHigh = claimTag('prio');
  assert.equal(claimedHigh.task_id, high.task_id);
  assert.equal(claimedHigh.status, 'dispatched');
  assert.ok(claimedHigh.claim_token);
  assert.ok(claimedHigh.lease_deadline > new Date().toISOString());
  const claimedLow = claimTag('prio');
  assert.equal(claimedLow.task_id, low.task_id);
  assert.equal(claimTag('prio'), null);
});

test('progress renews the lease and stores session events in order', () => {
  const task = makeTask('progress');
  const claimed = claimTag('progress');
  assert.equal(claimed.task_id, task.task_id);
  const running = repo.progress(task.task_id, claimed.claim_token, {
    note: 'working', percent: 30,
    events: [{ kind: 'tool/call', tool: 'shell', args: { cmd: 'ls' } }],
  });
  assert.equal(running.status, 'running');
  const events = repo.events(task.task_id);
  assert.deepEqual(events.map((event) => event.type), ['created', 'claimed', 'progress', 'session_event']);
  assert.equal(events.at(-1).payload.tool, 'shell');
});

test('claim token mismatches are rejected', () => {
  makeTask('mismatch');
  const claimed = claimTag('mismatch');
  assert.throws(() => repo.progress(claimed.task_id, 'forged-token', {}), /claim token mismatch/);
  assert.throws(() => repo.done(claimed.task_id, 'forged-token', { kind: 'done' }), /claim token mismatch/);
  const finished = repo.done(claimed.task_id, claimed.claim_token, { kind: 'done', result: { ok: true } });
  assert.equal(finished.status, 'done');
  assert.throws(() => repo.done(claimed.task_id, claimed.claim_token, { kind: 'done' }), /not active/);
});

test('done maps terminal result kinds and report onto terminal statuses', () => {
  const blocked = makeTask('kinds');
  let claimed = claimTag('kinds', 'machine:w2');
  assert.equal(repo.done(blocked.task_id, claimed.claim_token, { kind: 'blocked' }).status, 'blocked');
  const report = makeTask('kinds');
  claimed = claimTag('kinds', 'machine:w2');
  assert.equal(repo.done(report.task_id, claimed.claim_token, { kind: 'report' }).status, 'done');
  const fresh = makeTask('kinds');
  assert.throws(() => repo.done(fresh.task_id, 'x', { kind: 'nonsense' }), /unknown result kind/);
});

test('awaiting input preserves ownership and resumes under the same claim', () => {
  const task = makeTask('awaiting');
  const claimed = claimTag('awaiting', 'machine:input');
  const waiting = repo.enterAwaitingInput(task.task_id, claimed.claim_token, 'i-awaiting');
  assert.equal(waiting.status, 'awaiting_input');
  assert.equal(waiting.claim_worker_id, 'machine:input');
  assert.equal(waiting.claim_token, claimed.claim_token);
  assert.equal(repo.activeForWorker('machine:input')[0].task_id, task.task_id);
  const resumed = repo.resumeAfterInput(task.task_id, claimed.claim_token, 'i-awaiting');
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.claim_token, claimed.claim_token);
  assert.deepEqual(repo.events(task.task_id).map((event) => event.type), [
    'created', 'claimed', 'awaiting_input', 'input_delivered',
  ]);
});

test('undelivered dispatch rollback clears automatic assignment but preserves requested backend', () => {
  const automatic = makeTask('undelivered-auto');
  let claimed = claimTag('undelivered-auto');
  assert.equal(claimed.backend_kind, 'workflow-jsonl');
  let queued = repo.releaseUndeliveredClaim(automatic.task_id, claimed.claim_token);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.attempts, 0);
  assert.equal(queued.claim_token, null);
  assert.equal(queued.backend_kind, null);
  assert.equal(queued.requested_backend_kind, null);

  const explicit = makeTask('undelivered-explicit', { backend_kind: 'workflow-jsonl' });
  claimed = claimTag('undelivered-explicit');
  queued = repo.releaseUndeliveredClaim(explicit.task_id, claimed.claim_token);
  assert.equal(queued.backend_kind, 'workflow-jsonl');
  assert.equal(queued.requested_backend_kind, 'workflow-jsonl');
  assert.equal(repo.events(explicit.task_id).at(-1).type, 'dispatch_undelivered');
});

test('dependencies gate claiming until the predecessor is done', () => {
  const first = makeTask('dep');
  const second = makeTask('dep', { dependencies: [first.task_id] });
  const claimedFirst = claimTag('dep', 'machine:w3');
  assert.equal(claimedFirst.task_id, first.task_id);
  // `second` must not be claimable while its dependency is merely dispatched.
  assert.equal(claimTag('dep', 'machine:w3'), null);
  repo.done(first.task_id, claimedFirst.claim_token, { kind: 'done' });
  const claimedSecond = claimTag('dep', 'machine:w3');
  assert.equal(claimedSecond.task_id, second.task_id);
});

test('expired leases requeue, then dead-letter after max attempts', async () => {
  const task = makeTask('lease', { max_attempts: 2 });
  const first = claimTag('lease', 'machine:w4');
  assert.equal(first.task_id, task.task_id);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const reclaimed = claimTag('lease', 'machine:w5');
  assert.equal(reclaimed.task_id, task.task_id);
  assert.equal(reclaimed.attempts, 2);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(claimTag('lease', 'machine:w5'), null);
  const dead = repo.get(task.task_id);
  assert.equal(dead.status, 'failed');
  assert.equal(dead.result.reason, 'lease_expired_dead_letter');
  const types = repo.events(task.task_id).map((event) => event.type);
  assert.ok(types.includes('lease_expired_requeued'));
  assert.ok(types.includes('dead_letter'));
});

test('cancel works while active and is refused on terminal tasks', () => {
  const task = makeTask('cancel');
  const cancelled = repo.cancel(task.task_id, 'account:owner');
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => repo.cancel(task.task_id, 'account:owner'), /already cancelled/);
});

test('worker selector constrains claim eligibility', () => {
  const task = makeTask('selector', { worker_selector: { capabilities: ['gpu'], tag: 'selector' } });
  const plainClaim = repo.claim({
    worker_id: 'machine:plain', selector: { capabilities: ['cpu'], tag: 'selector' },
    backends: [{ kind: 'workflow-jsonl', capabilities: [] }],
  });
  assert.notEqual(plainClaim?.task_id, task.task_id);
  const gpuClaim = repo.claim({
    worker_id: 'machine:gpu', selector: { capabilities: ['gpu'], tag: 'selector' },
    backends: [{ kind: 'workflow-jsonl', capabilities: [] }],
  });
  assert.equal(gpuClaim.task_id, task.task_id);
});

test('backend and required capabilities constrain claim eligibility', () => {
  const task = makeTask('backend', {
    backend_kind: 'omp-rpc',
    required_capabilities: ['resume', 'tools'],
  });
  assert.equal(claimTag('backend', 'machine:jsonl', {
    backends: [{ kind: 'workflow-jsonl', capabilities: ['resume', 'tools'] }],
  }), null);
  assert.equal(claimTag('backend', 'machine:limited', {
    backends: [{ kind: 'omp-rpc', capabilities: ['resume'] }],
  }), null);
  const claimed = claimTag('backend', 'machine:omp', {
    capabilities: ['tools'],
    backends: [{ kind: 'omp-rpc', capabilities: ['resume'] }],
  });
  assert.equal(claimed.task_id, task.task_id);
  assert.equal(claimed.backend_kind, 'omp-rpc');
});

test('integrity and counts report cleanly', () => {
  assert.equal(repo.integrityCheck().ok, true);
  const counts = repo.countsByStatus();
  assert.ok(Number.isInteger(counts.queued ?? 0));
});
