// peer-sync-service.test.mjs - two-node in-process synchronization: outbox
// publication of locally-originated decisions, idempotent ingest on the peer,
// executor-published completion, conflict handling, and cursor tracking.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoreDatabase } from '../src/db/core-db.js';
import { createPeerSyncService } from '../src/sync/service.js';
import { TaskRepository } from '../src/tasks/repository.js';

function node(dir, nodeId) {
  const core = new CoreDatabase({ dataDir: fs.mkdtempSync(path.join(dir, `wfc-peer-${nodeId}-`)) });
  const tasks = new TaskRepository({ coreDb: core, nodeId });
  const service = createPeerSyncService({ coreDb: core, nodeId, taskRepository: tasks });
  return { core, tasks, service, close() { service.close(); tasks.close(); core.close(); } };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-peer-sync-'));
  const alpha = node(dir, 'node-alpha');
  const beta = node(dir, 'node-beta');
  return {
    dir, alpha, beta,
    close() { alpha.close(); beta.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function pullAll(source) {
  return source.service.eventsSince(0);
}

test('task creation publishes an outbox event and the peer applies the projection', () => {
  const value = fixture();
  try {
    value.beta.service.registerPeer({ node_id: 'node-alpha', endpoint: 'https://alpha.example:8710' });
    const { task } = value.alpha.tasks.create({
      type: 'code',
      brief: { prompt: 'synchronize me' },
      created_by: 'account:alice',
      project_id: 'project-a',
      origin_node_id: 'node-alpha',
      executor_node_id: 'node-beta',
    });

    const events = pullAll(value.alpha);
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, 'create');
    assert.equal(events[0].origin_node_id, 'node-alpha');
    assert.equal(events[0].payload.task_id, task.task_id);
    assert.equal(events[0].payload.executor_node_id, 'node-beta');
    assert.equal(events[0].payload.execution_policy_snapshot.executor_node_id, 'node-beta');

    const pushed = value.beta.service.ingest({ from_node: 'node-alpha', events });
    assert.equal(pushed.applied, 1);
    assert.deepEqual(pushed.results.map((r) => r.status), ['applied']);

    const projection = value.beta.tasks.get(task.task_id);
    assert.equal(projection.status, 'queued');
    assert.equal(projection.origin_node_id, 'node-alpha');
    assert.equal(projection.executor_node_id, 'node-beta');
    assert.deepEqual(projection.execution_policy_snapshot, {
      project_id: 'project-a', origin_node_id: 'node-alpha', executor_node_id: 'node-beta',
    });
    assert.deepEqual(value.beta.service.getCursor('node-alpha').inbound_cursor > 0, true);
  } finally {
    value.close();
  }
});

test('replayed events are idempotent duplicates and do not duplicate the projection', () => {
  const value = fixture();
  try {
    value.beta.service.registerPeer({ node_id: 'node-alpha' });
    value.alpha.tasks.create({
      type: 'code', brief: { prompt: 'once' }, created_by: 'account:alice',
      project_id: 'project-a', origin_node_id: 'node-alpha', executor_node_id: 'node-beta',
    });
    const events = pullAll(value.alpha);
    const first = value.beta.service.ingest({ from_node: 'node-alpha', events });
    assert.equal(first.results[0].status, 'applied');
    const replay = value.beta.service.ingest({ from_node: 'node-alpha', events });
    assert.equal(replay.results[0].status, 'duplicate');
    // The inbox records first-seen events only; replays surface in the push
    // response without duplicating receipts or projections.
    assert.equal(value.beta.service.status().inbox.applied, 1);
    assert.equal(value.beta.tasks.list({ project_id: 'project-a' }).length, 1);
  } finally {
    value.close();
  }
});

test('the executor node publishes completion and the origin applies the terminal state', () => {
  const value = fixture();
  try {
    for (const peer of [['node-alpha', value.alpha], ['node-beta', value.beta]]) {
      peer[1].service.registerPeer({ node_id: peer[0] === 'node-alpha' ? 'node-beta' : 'node-alpha' });
    }
    // Origin creates a project task executed by beta.
    const { task } = value.alpha.tasks.create({
      type: 'code', brief: { prompt: 'run on beta' }, created_by: 'account:alice',
      project_id: 'project-a', origin_node_id: 'node-alpha', executor_node_id: 'node-beta',
    });
    value.beta.service.ingest({ from_node: 'node-alpha', events: pullAll(value.alpha).filter((e) => e.entity_id === task.task_id) });

    // Beta's worker claims and completes the task locally; beta publishes the
    // completion because it is the executor, not the origin.
    const claimed = value.beta.tasks.claim({ worker_id: 'worker-beta-1', node_id: 'node-beta', backends: [{ kind: 'workflow-jsonl', capabilities: [] }] });
    assert.equal(claimed.task_id, task.task_id);
    value.beta.tasks.done(claimed.task_id, claimed.claim_token, { kind: 'done', result: { summary: 'built' } });
    const updates = pullAll(value.beta).filter((e) => e.entity_id === task.task_id && e.operation === 'update');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].payload.status, 'done');

    const applied = value.alpha.service.ingest({ from_node: 'node-beta', events: updates });
    assert.equal(applied.applied, 1);
    assert.equal(value.alpha.tasks.get(task.task_id).status, 'done');
    assert.deepEqual(value.alpha.tasks.get(task.task_id).result, { summary: 'built' });
    assert.equal(value.alpha.tasks.get(task.task_id).executor_node_id, 'node-beta');
  } finally {
    value.close();
  }
});

test('a terminal projection absorbs late or contradictory updates as conflicts', () => {
  const value = fixture();
  try {
    value.alpha.service.registerPeer({ node_id: 'node-beta' });
    value.beta.service.registerPeer({ node_id: 'node-alpha' });
    const { task } = value.alpha.tasks.create({
      type: 'code', brief: { prompt: 'terminal' }, created_by: 'account:alice',
      project_id: 'default', origin_node_id: 'node-alpha', executor_node_id: 'node-alpha',
    });
    value.alpha.tasks.cancel(task.task_id, 'account:alice');
    const allEvents = pullAll(value.alpha).filter((e) => e.entity_id === task.task_id);
    const updates = allEvents.filter((e) => e.operation === 'update');
    assert.equal(updates.length, 1);

    // The projection must exist before the update: sync the create first.
    const bootstrap = value.beta.service.ingest({
      from_node: 'node-alpha',
      events: allEvents.filter((e) => e.operation === 'create'),
    });
    assert.equal(bootstrap.applied, 1);
    const first = value.beta.service.ingest({ from_node: 'node-alpha', events: updates });
    assert.equal(first.results[0].status, 'applied');
    const replayedWithDifferentOutcome = value.beta.service.ingest({
      from_node: 'node-alpha',
      events: [{ ...updates[0], event_id: `${updates[0].event_id}-variant`, seq: updates[0].seq + 500, payload: { ...updates[0].payload, status: 'done' } }],
    });
    assert.equal(replayedWithDifferentOutcome.conflicts, 1);
    assert.equal(value.beta.tasks.get(task.task_id).status, 'cancelled');
    const sameOutcome = value.beta.service.ingest({
      from_node: 'node-alpha',
      events: [{ ...updates[0], event_id: `${updates[0].event_id}-same`, seq: updates[0].seq + 501 }],
    });
    assert.equal(sameOutcome.results[0].status, 'duplicate');
  } finally {
    value.close();
  }
});

test('peers cannot spoof another origin, push before registering, or drive foreign tasks', () => {
  const value = fixture();
  try {
    value.beta.service.registerPeer({ node_id: 'node-alpha' });
    value.beta.service.registerPeer({ node_id: 'node-gamma' });
    const spoofed = value.beta.service.ingest({
      from_node: 'node-alpha',
      events: [{
        event_id: 'pse-spoof', seq: 1, origin_node_id: 'node-gamma', entity_type: 'task',
        entity_id: 't-1', operation: 'create', payload: { task_id: 't-1', type: 'code', brief: {}, created_by: 'x', project_id: 'default', origin_node_id: 'node-gamma' },
      }],
    });
    assert.equal(spoofed.results[0].status, 'rejected');

    assert.throws(
      () => value.beta.service.ingest({ from_node: 'node-unknown', events: [] }),
      (error) => error.code === 'PEER_UNKNOWN',
    );

    // Node-alpha owns the whole lifecycle of its default task; node-gamma,
    // even registered, may not drive it on node-beta's projection.
    const { task } = value.alpha.tasks.create({
      type: 'code', brief: { prompt: 'origin-owned' }, created_by: 'account:alice',
      project_id: 'default', origin_node_id: 'node-alpha', executor_node_id: 'node-alpha',
    });
    const createEvents = pullAll(value.alpha).filter((e) => e.entity_id === task.task_id);
    const projection = value.beta.service.ingest({ from_node: 'node-alpha', events: createEvents });
    assert.equal(projection.applied, 1);

    const unauthorized = value.beta.service.ingest({
      from_node: 'node-gamma',
      events: [{
        event_id: 'pse-foreign', seq: 2, origin_node_id: 'node-gamma', entity_type: 'task',
        entity_id: task.task_id, operation: 'update', payload: { status: 'done' },
      }],
    });
    assert.equal(unauthorized.results[0].status, 'rejected');
    assert.deepEqual(unauthorized.results[0].detail, { reason: 'unauthorized_publisher' });
    assert.equal(value.beta.tasks.get(task.task_id).status, 'queued');

    assert.throws(
      () => value.beta.service.registerPeer({ node_id: 'node-beta', protocol_version: 99 }),
      (error) => error.code === 'PEER_PROTOCOL_UNSUPPORTED',
    );
  } finally {
    value.close();
  }
});

test('outbox paging stops at the limit and acks track per-peer progress', () => {
  const value = fixture();
  try {
    value.alpha.service.registerPeer({ node_id: 'node-beta' });
    value.alpha.service.registerPeer({ node_id: 'node-gamma' });
    for (let index = 0; index < 5; index += 1) {
      value.alpha.tasks.create({
        type: 'code', brief: { prompt: `batch-${index}` }, created_by: 'account:alice',
        project_id: 'default', origin_node_id: 'node-alpha', executor_node_id: 'node-alpha',
      });
    }
    const firstPage = value.alpha.service.eventsSince(0, { limit: 3 });
    assert.equal(firstPage.length, 3);
    const secondPage = value.alpha.service.eventsSince(firstPage.next_seq_hint ?? firstPage[firstPage.length - 1].seq, { limit: 3 });
    assert.equal(secondPage.length, 2);

    assert.deepEqual(value.alpha.service.recordAck('node-beta', 4), {
      peer_node_id: 'node-beta', inbound_cursor: 0, outbound_acked_seq: 4, updated_at: value.alpha.service.getCursor('node-beta').updated_at,
    });
    assert.deepEqual(value.alpha.service.getCursor('node-gamma'), {
      peer_node_id: 'node-gamma', inbound_cursor: 0, outbound_acked_seq: 0, updated_at: null,
    });
    const head = value.alpha.service.headSeq();
    assert.equal(head, 5);
  } finally {
    value.close();
  }
});

test('revoked peers are refused at ingest and ack', () => {
  const value = fixture();
  try {
    value.beta.service.registerPeer({ node_id: 'node-alpha' });
    value.beta.service.revokePeer('node-alpha');
    assert.throws(
      () => value.beta.service.ingest({ from_node: 'node-alpha', events: [] }),
      (error) => error.code === 'PEER_UNKNOWN',
    );
    assert.throws(
      () => value.beta.service.recordAck('node-alpha', 1),
      (error) => error.code === 'PEER_UNKNOWN',
    );
    // Re-registration restores access.
    value.beta.service.registerPeer({ node_id: 'node-alpha' });
    assert.equal(value.beta.service.ingest({ from_node: 'node-alpha', events: [] }).applied, 0);
  } finally {
    value.close();
  }
});
