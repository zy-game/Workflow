// peer-sync-e2e.test.mjs - two real Core HTTP nodes, each running the sync
// client against the other: task creation propagates, the executor's
// completion propagates back, offline periods replay from persisted cursors,
// and acked outbox events are pruned.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { loadConfig } from '../src/config.js';
import { createPeerSyncClient } from '../src/sync/client.js';
import { createPeerSyncService } from '../src/sync/service.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { TaskRepository } from '../src/tasks/repository.js';

const nodes = [];

async function startNode(nodeId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wfc-peer-e2e-${nodeId}-`));
  const auth = new AuthRepository({ dataDir: dir });
  const core = new CoreDatabase({ dataDir: dir });
  const tasks = new TaskRepository({ coreDb: core, nodeId });
  const service = createPeerSyncService({ coreDb: core, nodeId, taskRepository: tasks });
  const app = createCoreServer({ config: {}, nodeId, authRepository: auth, taskRepository: tasks, peerSyncService: service });
  const server = await app.listen({ host: '127.0.0.1', port: 0, tls: null });
  const node = {
    nodeId,
    dir,
    auth,
    core,
    tasks,
    service,
    base: `http://127.0.0.1:${server.address().port}`,
    tokens: {},
    server,
    clients: [],
    close() {
      server.close();
      service.close();
      tasks.close();
      core.close();
      auth.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  nodes.push(node);
  return node;
}

// Each node issues the peer machine token the other node presents.
function issuePeerTokens(a, b) {
  a.tokens[b.nodeId] = a.auth.createMachineToken({ subject_id: b.nodeId, role: 'peer', project_ids: [] }).token;
  b.tokens[a.nodeId] = b.auth.createMachineToken({ subject_id: a.nodeId, role: 'peer', project_ids: [] }).token;
}

function clientFor(node, peer, intervalMs = 15_000) {
  const client = createPeerSyncClient({
    peerSyncService: node.service,
    nodeId: node.nodeId,
    intervalMs,
    peers: [{ node_id: peer.nodeId, endpoint: peer.base, token: peer.tokens[node.nodeId] }],
  });
  node.clients.push(client);
  return client;
}

async function waitFor(description, probe, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

after(() => {
  for (const node of nodes.reverse()) {
    for (const client of node.clients) client.stop();
    node.close();
  }
});

test('sync client and config reject malformed peer configuration', () => {
  assert.throws(
    () => createPeerSyncClient({
      peerSyncService: { nodeId: 'node-alpha' },
      nodeId: 'node-alpha',
      peers: [{ node_id: 'node-alpha', endpoint: 'https://self.example', token: 'wfc-x' }],
    }),
    /cannot configure itself as a peer/,
  );

  const base = { WFC_DATA_DIR: os.tmpdir(), WFC_ALLOW_PLAIN_HTTP: '1' };
  const peers = loadConfig({
    ...base,
    WFC_PEERS_JSON: JSON.stringify([{ node_id: 'node-beta', endpoint: 'https://beta.example:8710/', token: 'wfc-peer' }]),
  }).peers;
  assert.deepEqual(peers, [{ node_id: 'node-beta', endpoint: 'https://beta.example:8710', token: 'wfc-peer' }]);

  assert.throws(
    () => loadConfig({ ...base, WFC_PEERS_JSON: '[{"node_id":"Bad_Node","endpoint":"https://x","token":"t"}]' }),
    /node_id must match/,
  );
  assert.throws(
    () => loadConfig({ ...base, WFC_PEERS_JSON: '[{"node_id":"node-beta","endpoint":"ftp://x","token":"t"}]' }),
    /absolute http/,
  );
  assert.throws(
    () => loadConfig({ ...base, WFC_PEERS_JSON: '[{"node_id":"node-beta","endpoint":"https://x"}]' }),
    /token is required/,
  );
});

test('two nodes converge through pull clients, replay offline events, and prune acked outbox', async () => {
  const alpha = await startNode('node-alpha');
  const beta = await startNode('node-beta');
  issuePeerTokens(alpha, beta);
  const alphaClient = clientFor(alpha, beta);
  const betaClient = clientFor(beta, alpha);
  alphaClient.start();
  betaClient.start();

  // --- origin-side creation propagates to the peer ---
  const { task } = alpha.tasks.create({
    type: 'code', brief: { prompt: 'hello peers' }, created_by: 'account:alice',
    project_id: 'default', origin_node_id: 'node-alpha', executor_node_id: 'node-alpha',
  });
  await waitFor('task projection on beta', () => beta.tasks.get(task.task_id));
  assert.equal(beta.tasks.get(task.task_id).executor_node_id, 'node-alpha');
  // Beta is not the executor: its worker claims must skip the projection.
  assert.equal(beta.tasks.claim({ worker_id: 'worker-beta', node_id: 'node-beta', backends: [{ kind: 'workflow-jsonl', capabilities: [] }] }), null);

  // --- offline replay: beta stops pulling, catches up from the cursor ---
  await betaClient.stop();
  const offline = [1, 2].map(() => alpha.tasks.create({
    type: 'code', brief: { prompt: 'while beta away' }, created_by: 'account:alice',
    project_id: 'default', origin_node_id: 'node-alpha', executor_node_id: 'node-alpha',
  }).task);
  betaClient.start();
  await waitFor('offline replay on beta', () => offline.every((entry) => beta.tasks.get(entry.task_id)));

  // --- executor-side completion propagates back to the origin ---
  const delegated = alpha.tasks.create({
    type: 'code', brief: { prompt: 'run on beta' }, created_by: 'account:alice',
    project_id: 'project-b', origin_node_id: 'node-alpha', executor_node_id: 'node-beta',
  }).task;
  await betaClient.tick();
  await waitFor('delegated projection on beta', () => beta.tasks.get(delegated.task_id));
  const claimed = await waitFor('claimable delegated task on beta', () => beta.tasks.claim({
    worker_id: 'worker-beta-1', node_id: 'node-beta', backends: [{ kind: 'workflow-jsonl', capabilities: [] }],
  }));
  assert.equal(claimed.task_id, delegated.task_id);
  beta.tasks.done(delegated.task_id, claimed.claim_token, { kind: 'done', result: { summary: 'built on beta' } });
  await alphaClient.tick();
  await waitFor('completion back on alpha', () => alpha.tasks.get(delegated.task_id)?.status === 'done');
  assert.deepEqual(alpha.tasks.get(delegated.task_id).result, { summary: 'built on beta' });
  // Routing stays frozen on the origin after synchronization.
  assert.equal(alpha.tasks.get(delegated.task_id).executor_node_id, 'node-beta');

  // --- acks let the origin prune what every active peer has consumed ---
  // Alpha's client already pruned its fully-acked outbox during its last
  // tick; pruning again is a no-op and consumed sequences are not reused.
  await betaClient.tick();
  const ackedThrough = alpha.service.getCursor('node-beta').outbound_acked_seq;
  assert.equal(ackedThrough >= 4, true);
  assert.deepEqual(alpha.service.eventsSince(0), []);
  assert.equal(alpha.service.pruneAcked(), 0);
  const trailing = alpha.tasks.create({
    type: 'code', brief: { prompt: 'after prune' }, created_by: 'account:alice',
    project_id: 'default', origin_node_id: 'node-alpha', executor_node_id: 'node-alpha',
  }).task;
  const trailingEvents = alpha.service.eventsSince(0);
  assert.equal(trailingEvents.length, 1);
  assert.equal(trailingEvents[0].entity_id, trailing.task_id);
  assert.ok(trailingEvents[0].seq > ackedThrough);

  await alphaClient.stop();
  await betaClient.stop();
});
