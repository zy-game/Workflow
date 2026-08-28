import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BridgeRequestsRepository, canonicalPayloadHash } from '../src/bridge/requests-repository.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { transaction } from '../src/db/base.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-bridge-requests-'));
  const core = new CoreDatabase({ dataDir: dir });
  return {
    core,
    repository: new BridgeRequestsRepository({ coreDb: core }),
    close() {
      core.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('canonical payload hashes ignore object key order but preserve array order', () => {
  assert.equal(canonicalPayloadHash({ b: 2, a: { y: 1, x: true } }), canonicalPayloadHash({ a: { x: true, y: 1 }, b: 2 }));
  assert.notEqual(canonicalPayloadHash({ values: [1, 2] }), canonicalPayloadHash({ values: [2, 1] }));
});

test('execute stores and replays the original response without rerunning mutation', () => {
  const value = fixture();
  try {
    let mutations = 0;
    const request = { bridgeId: 'bridge-1', requestId: 'request-1', operation: 'result', taskId: 'task-1', payload: { ok: true } };
    const first = value.repository.execute(request, () => {
      mutations += 1;
      return { status: 202, response: { accepted: true } };
    });
    const replay = value.repository.execute({ ...request, payload: { ok: true } }, () => {
      mutations += 1;
      return { status: 500, response: {} };
    });
    assert.deepEqual(first, { status: 202, response: { accepted: true }, replayed: false });
    assert.deepEqual(replay, { status: 202, response: { accepted: true }, replayed: true });
    assert.equal(mutations, 1);
  } finally {
    value.close();
  }
});

test('execute rejects request identity reuse with different semantics', () => {
  const value = fixture();
  try {
    const request = { bridgeId: 'bridge-1', requestId: 'request-1', operation: 'events', taskId: 'task-1', payload: { seq: 1 } };
    value.repository.execute(request, () => ({ status: 200, response: { accepted: true } }));
    assert.throws(
      () => value.repository.execute({ ...request, payload: { seq: 2 } }, () => ({ status: 200, response: {} })),
      (error) => error?.code === 'BRIDGE_REQUEST_CONFLICT',
    );
  } finally {
    value.close();
  }
});

test('mutation and response record commit or roll back together with nested repository transactions', () => {
  const value = fixture();
  try {
    value.core.db.exec('CREATE TABLE bridge_test_mutations (id TEXT PRIMARY KEY)');
    const nestedMutation = (id) => transaction(value.core.db, () => {
      value.core.db.prepare('INSERT INTO bridge_test_mutations(id) VALUES (?)').run(id);
      return { status: 200, response: { id } };
    });
    value.repository.execute(
      { bridgeId: 'bridge-1', requestId: 'committed', operation: 'test', payload: {} },
      () => nestedMutation('committed'),
    );
    assert.equal(value.core.db.prepare('SELECT COUNT(*) AS count FROM bridge_test_mutations').get().count, 1);
    assert.throws(
      () => value.repository.execute(
        { bridgeId: 'bridge-1', requestId: 'rolled-back', operation: 'test', payload: {} },
        () => {
          nestedMutation('rolled-back');
          throw new Error('fail after mutation');
        },
      ),
      /fail after mutation/,
    );
    assert.equal(value.core.db.prepare("SELECT COUNT(*) AS count FROM bridge_test_mutations WHERE id = 'rolled-back'").get().count, 0);
    assert.equal(value.repository.get('bridge-1', 'rolled-back'), null);
  } finally {
    value.close();
  }
});

test('expired request records are pruned in bounded batches', () => {
  const value = fixture();
  try {
    value.repository.execute(
      { bridgeId: 'bridge-1', requestId: 'expired', operation: 'test', payload: {} },
      () => ({ status: 200, response: {} }),
    );
    value.core.db.prepare("UPDATE bridge_requests SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    assert.equal(value.repository.pruneExpired({ limit: 1 }), 1);
    assert.equal(value.repository.get('bridge-1', 'expired'), null);
  } finally {
    value.close();
  }
});
