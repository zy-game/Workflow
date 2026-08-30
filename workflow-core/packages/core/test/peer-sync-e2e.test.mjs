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
import { CoreDatabase } from '../src/db/core-db.js';
import { WorkflowRepository } from '../src/knowledge/repository.js';
import { createCoreServer } from '../src/http/server.js';
import { TaskCreationFacade } from '../src/tasks/creation-facade.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { createPeerSyncClient } from '../src/sync/client.js';
import { loadSyncKeyPair } from '../src/sync/sync-key.js';
import { createPeerSyncService } from '../src/sync/service.js';

const nodes = [];

async function startNode(nodeId, { sign = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wfc-peer-e2e-${nodeId}-`));
  const auth = new AuthRepository({ dataDir: dir });
  const core = new CoreDatabase({ dataDir: dir });
  const tasks = new TaskRepository({ coreDb: core, nodeId });
  const knowledge = new WorkflowRepository({ filename: path.join(dir, 'workflow.db') });
  const keyPair = sign ? loadSyncKeyPair({ dataDir: dir }) : null;
  const service = createPeerSyncService({
    coreDb: core,
    nodeId,
    taskRepository: tasks,
    knowledgeRepository: knowledge,
    signingKey: keyPair ? { privateKey: keyPair.privateKey, publicKeyBase64: keyPair.publicKeyBase64 } : null,
  });
  const app = createCoreServer({ config: {}, nodeId, authRepository: auth, taskRepository: tasks, peerSyncService: service });
  const server = await app.listen({ host: '127.0.0.1', port: 0, tls: null });
  const node = {
    nodeId,
    dir,
    auth,
    core,
    tasks,
    knowledge,
    service,
    base: `http://127.0.0.1:${server.address().port}`,
    tokens: {},
    server,
    clients: [],
    close() {
      server.close();
      service.close();
      tasks.close();
      knowledge.close();
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
    WFC_PEERS_JSON: JSON.stringify([{ node_id: 'node-beta', endpoint: 'https://beta.example:8710/', token: 'wfc-peer', push: true }]),
  }).peers;
  assert.deepEqual(peers, [{ node_id: 'node-beta', endpoint: 'https://beta.example:8710', token: 'wfc-peer', pull: true, push: true }]);
  assert.deepEqual(loadConfig({ ...base, WFC_PEERS_JSON: JSON.stringify([{ node_id: 'node-beta', endpoint: 'https://beta.example', token: 't', pull: false }]) }).peers,
    [{ node_id: 'node-beta', endpoint: 'https://beta.example', token: 't', pull: false, push: false }]);
  assert.throws(
    () => loadConfig({ ...base, WFC_PEERS_JSON: '[{"node_id":"node-beta","endpoint":"https://x","token":"t","push":"yes"}]' }),
    /push must be a boolean/,
  );

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

test('project ownership synchronizes and routes cross-node tasks to the owner', async () => {
  const alpha = await startNode('node-alpha');
  const beta = await startNode('node-beta');
  issuePeerTokens(alpha, beta);
  const alphaClient = clientFor(alpha, beta);
  const betaClient = clientFor(beta, alpha);
  alphaClient.start();
  betaClient.start();

  // The owner announces its project; beta receives the registry entry
  // location-less and can route tasks for it.
  const project = alpha.knowledge.resolveProject({
    path: 'E:\\Workflow\\Shared', machine: 'alpha-box',
    metadata: { owner_node_id: 'node-alpha' },
  });
  await betaClient.tick();
  assert.equal(beta.knowledge.getProject(project.id)?.metadata.owner_node_id, 'node-alpha');

  // Beta creates a task for the synced project through the routing facade;
  // the owner lookup resolves to node-alpha as executor.
  const betaFacade = new TaskCreationFacade({
    taskRepository: beta.tasks, knowledgeRepository: beta.knowledge, nodeId: 'node-beta',
  });
  const { task } = betaFacade.create({
    type: 'code', brief: { prompt: 'owner should run this' }, created_by: 'account:bob',
    project_id: project.id,
  });
  assert.equal(task.executor_node_id, 'node-alpha');
  assert.equal(task.origin_node_id, 'node-beta');

  await alphaClient.tick();
  await waitFor('task projection on the owner', () => alpha.tasks.get(task.task_id));
  const claimed = await waitFor('claim on the owner node', () => alpha.tasks.claim({
    worker_id: 'worker-alpha-1', node_id: 'node-alpha', backends: [{ kind: 'workflow-jsonl', capabilities: [] }],
  }));
  assert.equal(claimed.task_id, task.task_id);
  alpha.tasks.done(task.task_id, claimed.claim_token, { kind: 'done', result: { summary: 'owner ran it' } });

  await betaClient.tick();
  await waitFor('completion visible on the origin node', () => beta.tasks.get(task.task_id)?.status === 'done');
  assert.equal(beta.tasks.get(task.task_id).executor_node_id, 'node-alpha');

  await alphaClient.stop();
  await betaClient.stop();
});

test('execution state stays live on peers and revocation permanently stops a pull client', async () => {
  const alpha = await startNode('node-alpha');
  const beta = await startNode('node-beta');
  issuePeerTokens(alpha, beta);
  const alphaClient = clientFor(alpha, beta);
  const betaClient = clientFor(beta, alpha);
  alphaClient.start();
  betaClient.start();

  // The peer sees dispatched/running while the owner node works.
  const { task } = alpha.tasks.create({
    type: 'code', brief: { prompt: 'live status' }, created_by: 'account:alice',
    project_id: 'default', origin_node_id: 'node-alpha', executor_node_id: 'node-alpha',
  });
  await betaClient.tick();
  await waitFor('projection on beta', () => beta.tasks.get(task.task_id));
  const claimed = alpha.tasks.claim({ worker_id: 'worker-alpha-1', node_id: 'node-alpha', backends: [{ kind: 'workflow-jsonl', capabilities: [] }] });
  alpha.tasks.progress(task.task_id, claimed.claim_token, { note: 'halfway', percent: 50 });
  await betaClient.tick();
  await waitFor('running status on beta', () => beta.tasks.get(task.task_id)?.status === 'running');
  assert.equal(beta.tasks.get(task.task_id).result, null);

  // Once beta revokes alpha, beta's client drops alpha permanently: further
  // owner-side events never arrive until an administrator re-activates.
  beta.service.revokePeer('node-alpha');
  const blocked = alpha.tasks.create({
    type: 'code', brief: { prompt: 'after revoke' }, created_by: 'account:alice',
    project_id: 'default', origin_node_id: 'node-alpha', executor_node_id: 'node-alpha',
  }).task;
  await betaClient.tick();
  await betaClient.tick();
  assert.deepEqual(betaClient.revokedPeers(), ['node-alpha']);
  assert.equal(beta.tasks.get(blocked.task_id), null);
  assert.equal(beta.service.getPeer('node-alpha').status, 'revoked');

  await alphaClient.stop();
  await betaClient.stop();
});

test('a node that cannot accept inbound connections still converges via push', async () => {
  // Simulated NAT: only beta can initiate connections. Beta pulls from alpha
  // and pushes to it; alpha has no client and never connects to beta.
  const alpha = await startNode('node-alpha');
  const beta = await startNode('node-beta');
  issuePeerTokens(alpha, beta);
  const betaClient = createPeerSyncClient({
    peerSyncService: beta.service,
    nodeId: 'node-beta',
    intervalMs: 15_000,
    peers: [{ node_id: 'node-alpha', endpoint: alpha.base, token: alpha.tokens['node-beta'], pull: true, push: true }],
  });
  beta.clients.push(betaClient);
  betaClient.start();

  // Alpha's decision reaches beta through pull...
  const local = alpha.tasks.create({
    type: 'code', brief: { prompt: 'alpha work' }, created_by: 'account:alice',
    project_id: 'default', origin_node_id: 'node-alpha', executor_node_id: 'node-alpha',
  }).task;
  await waitFor('local task on beta via pull', () => beta.tasks.get(local.task_id));

  // ...and beta's execution reaches alpha through push alone.
  const delegated = alpha.tasks.create({
    type: 'code', brief: { prompt: 'run on beta' }, created_by: 'account:alice',
    project_id: 'project-b', origin_node_id: 'node-alpha', executor_node_id: 'node-beta',
  }).task;
  await betaClient.tick();
  await waitFor('delegated task on beta via pull', () => beta.tasks.get(delegated.task_id));
  const claimed = await waitFor('claim on beta', () => beta.tasks.claim({
    worker_id: 'worker-beta-1', node_id: 'node-beta', backends: [{ kind: 'workflow-jsonl', capabilities: [] }],
  }));
  assert.equal(claimed.task_id, delegated.task_id);
  beta.tasks.done(delegated.task_id, claimed.claim_token, { kind: 'done', result: { summary: 'built behind NAT' } });
  await betaClient.tick();
  await waitFor('completion pushed back to alpha', () => alpha.tasks.get(delegated.task_id)?.status === 'done');
  assert.deepEqual(alpha.tasks.get(delegated.task_id).result, { summary: 'built behind NAT' });

  // The push echo advanced beta's outbound ack bookkeeping and alpha's
  // inbound cursor without alpha ever connecting to beta.
  assert.ok(beta.service.getCursor('node-alpha').outbound_acked_seq > 0);
  assert.ok(alpha.service.getCursor('node-beta').inbound_cursor > 0);

  await betaClient.stop();
});

test('signed nodes converge: keys pin via handshake and tampering fails closed', async () => {
  const alpha = await startNode('node-alpha', { sign: true });
  const beta = await startNode('node-beta', { sign: true });
  issuePeerTokens(alpha, beta);
  const alphaClient = clientFor(alpha, beta);
  const betaClient = clientFor(beta, alpha);
  alphaClient.start();
  betaClient.start();

  const { task } = alpha.tasks.create({
    type: 'code', brief: { prompt: 'signed flow' }, created_by: 'account:alice',
    project_id: 'default', origin_node_id: 'node-alpha', executor_node_id: 'node-alpha',
  });
  await betaClient.tick();
  await waitFor('signed projection on beta', () => beta.tasks.get(task.task_id));
  // Both directions pinned each other's public key during handshake.
  assert.equal(alpha.service.getPeer('node-beta').public_key, beta.service.publicKeyBase64);
  assert.equal(beta.service.getPeer('node-alpha').public_key, alpha.service.publicKeyBase64);
  assert.equal(beta.service.status().inbox.applied >= 1, true);

  // The executor's completion is signed by beta and verified by alpha.
  const delegated = alpha.tasks.create({
    type: 'code', brief: { prompt: 'signed delegation' }, created_by: 'account:alice',
    project_id: 'project-s', origin_node_id: 'node-alpha', executor_node_id: 'node-beta',
  }).task;
  await betaClient.tick();
  await waitFor('delegated projection on beta', () => beta.tasks.get(delegated.task_id));
  const claimed = await waitFor('claim on beta', () => beta.tasks.claim({
    worker_id: 'worker-beta-1', node_id: 'node-beta', backends: [{ kind: 'workflow-jsonl', capabilities: [] }],
  }));
  beta.tasks.done(claimed.task_id, claimed.claim_token, { kind: 'done', result: { summary: 'signed done' } });
  await alphaClient.tick();
  await waitFor('signed completion back on alpha', () => alpha.tasks.get(delegated.task_id)?.status === 'done');
  assert.deepEqual(alpha.tasks.get(delegated.task_id).result, { summary: 'signed done' });

  await alphaClient.stop();
  await betaClient.stop();
});
