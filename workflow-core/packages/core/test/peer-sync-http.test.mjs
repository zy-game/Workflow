// peer-sync-http.test.mjs - HTTP contract for peer sync: dedicated peer
// tokens, handshake, pull, push, and ack. Peer identity always comes from the
// token subject, never from the request body.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { createPeerSyncService } from '../src/sync/service.js';
import { TaskRepository } from '../src/tasks/repository.js';

const NODE_ID = 'node-alpha';

let dir;
let auth;
let coreDatabase;
let tasks;
let server;
let base;
let peerToken;
let workerToken;

async function call(pathname, { token = peerToken, method = 'POST', body = {} } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const options = { method, headers };
  if (method !== 'GET') options.body = JSON.stringify(body);
  const response = await fetch(`${base}${pathname}`, options);
  return { status: response.status, body: await response.json() };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-peer-http-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDatabase = new CoreDatabase({ dataDir: dir });
  tasks = new TaskRepository({ coreDb: coreDatabase, nodeId: NODE_ID });
  const peerSyncService = createPeerSyncService({ coreDb: coreDatabase, nodeId: NODE_ID, taskRepository: tasks });
  peerToken = auth.createMachineToken({ subject_id: 'node-beta', role: 'peer', project_ids: [] }).token;
  workerToken = auth.createMachineToken({ subject_id: 'worker-a', role: 'worker', project_ids: [] }).token;
  const app = createCoreServer({
    config: {}, nodeId: NODE_ID, authRepository: auth, taskRepository: tasks, peerSyncService,
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

test('peer sync routes reject non-peer tokens and require a registered peer', async () => {
  const workerHandshake = await call('/api/v1/peer/sync/handshake', { token: workerToken });
  assert.equal(workerHandshake.status, 403);

  const anonymous = await call('/api/v1/peer/sync/pull', { token: null });
  assert.equal(anonymous.status, 401);

  const unregistered = await call('/api/v1/peer/sync/pull', { body: { since_seq: 0 } });
  assert.equal(unregistered.status, 403);
  assert.equal(unregistered.body.code, 'PEER_UNKNOWN');
});

test('handshake registers the caller and returns our node identity', async () => {
  const handshake = await call('/api/v1/peer/sync/handshake', {
    body: { endpoint: 'https://beta.example:8710', display_name: 'beta laptop' },
  });
  assert.equal(handshake.status, 200);
  assert.equal(handshake.body.node_id, NODE_ID);
  assert.equal(handshake.body.peer.node_id, 'node-beta');
  assert.equal(handshake.body.peer.status, 'active');
  assert.equal(handshake.body.protocol_version, 1);
});

test('pull returns locally-originated decisions after the given cursor', async () => {
  tasks.create({
    type: 'code', brief: { prompt: 'alpha-owned work' }, created_by: 'account:alice',
    project_id: 'default', origin_node_id: NODE_ID, executor_node_id: NODE_ID,
  });
  const pull = await call('/api/v1/peer/sync/pull', { body: { since_seq: 0, limit: 100 } });
  assert.equal(pull.status, 200);
  assert.equal(pull.body.events.length, 1);
  assert.equal(pull.body.events[0].operation, 'create');
  assert.equal(pull.body.next_seq, pull.body.events[0].seq);

  const emptyPull = await call('/api/v1/peer/sync/pull', { body: { since_seq: pull.body.next_seq } });
  assert.equal(emptyPull.body.events.length, 0);
  assert.equal(emptyPull.body.next_seq, pull.body.next_seq);
});

test('push applies peer events idempotently under the token identity', async () => {
  const event = {
    event_id: 'pse-http-1', seq: 7, origin_node_id: 'node-beta', entity_type: 'task',
    entity_id: 't-beta-http-1', operation: 'create',
    payload: {
      task_id: 't-beta-http-1', type: 'code', brief: { prompt: 'from beta' },
      created_by: 'account:bob', project_id: 'default', origin_node_id: 'node-beta',
      executor_node_id: 'node-beta', execution_policy_snapshot: { project_id: 'default', origin_node_id: 'node-beta', executor_node_id: 'node-beta' },
    },
  };
  const first = await call('/api/v1/peer/sync/push', { body: { events: [event] } });
  assert.equal(first.status, 200);
  assert.equal(first.body.applied, 1);
  assert.equal(first.body.results[0].status, 'applied');

  const replay = await call('/api/v1/peer/sync/push', { body: { events: [event] } });
  assert.equal(replay.body.results[0].status, 'duplicate');

  const projection = tasks.get('t-beta-http-1');
  assert.equal(projection.origin_node_id, 'node-beta');
  assert.equal(projection.executor_node_id, 'node-beta');
});

test('push rejects events whose origin does not match the authenticated peer', async () => {
  const forged = {
    event_id: 'pse-forged', seq: 8, origin_node_id: 'node-gamma', entity_type: 'task',
    entity_id: 't-gamma-1', operation: 'create',
    payload: { task_id: 't-gamma-1', type: 'code', brief: {}, created_by: 'x', project_id: 'default', origin_node_id: 'node-gamma' },
  };
  const rejected = await call('/api/v1/peer/sync/push', { body: { events: [forged] } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.results[0].status, 'rejected');
  assert.equal(tasks.get('t-gamma-1'), null);
});

test('ack records the peer cursor and status reports the sync state', async () => {
  const ack = await call('/api/v1/peer/sync/ack', { body: { seq: 3 } });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.cursor.outbound_acked_seq, 3);

  const status = await call('/api/v1/peer/sync/status', { method: 'GET' });
  assert.equal(status.status, 200);
  assert.equal(status.body.node_id, NODE_ID);
  assert.equal(status.body.head_seq >= 1, true);
  // Forged events are rejected before any inbox receipt, and the replayed
  // event only surfaces in its push response, so one applied receipt remains.
  assert.deepEqual(status.body.inbox, { applied: 1 });
});
