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
    type: 'dsh.run',
    brief: { goal: 'do the thing', acceptance: ['it is done'] },
    created_by: 'account:owner',
    ...rest,
    worker_selector: worker_selector ?? { tag },
  }).task;
}

function claimTag(tag, worker = 'machine:w1') {
  return repo.claim({ worker_id: worker, selector: { tag } });
}

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

test('done maps result kinds onto statuses', () => {
  const blocked = makeTask('kinds');
  let claimed = claimTag('kinds', 'machine:w2');
  assert.equal(repo.done(blocked.task_id, claimed.claim_token, { kind: 'blocked' }).status, 'blocked');
  const question = makeTask('kinds');
  claimed = claimTag('kinds', 'machine:w2');
  assert.equal(repo.done(question.task_id, claimed.claim_token, { kind: 'question' }).status, 'awaiting_input');
  const fresh = makeTask('kinds');
  assert.throws(() => repo.done(fresh.task_id, 'x', { kind: 'nonsense' }), /unknown result kind/);
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
  const plainClaim = repo.claim({ worker_id: 'machine:plain', selector: { capabilities: ['cpu'], tag: 'selector' } });
  assert.notEqual(plainClaim?.task_id, task.task_id);
  const gpuClaim = repo.claim({ worker_id: 'machine:gpu', selector: { capabilities: ['gpu'], tag: 'selector' } });
  assert.equal(gpuClaim.task_id, task.task_id);
});

test('integrity and counts report cleanly', () => {
  assert.equal(repo.integrityCheck().ok, true);
  const counts = repo.countsByStatus();
  assert.ok(Number.isInteger(counts.queued ?? 0));
});
