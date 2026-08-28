import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoreDatabase } from '../src/db/core-db.js';
import { WorkersRegistry } from '../src/workers/registry.js';

test('registry persists pull transport metadata and records pull liveness', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-worker-registry-'));
  const core = new CoreDatabase({ dataDir: dir });
  try {
    const registry = new WorkersRegistry({ coreDb: core });
    const registered = registry.register({
      worker_id: 'bridge-1',
      subject_id: 'machine:bridge-1',
      transport: 'pull',
      bridge_protocol_version: 1,
    });
    assert.equal(registered.transport, 'pull');
    assert.equal(registered.bridge_protocol_version, 1);
    assert.equal(registered.last_pull_at, null);

    assert.equal(registry.heartbeat('bridge-1', { pulled: true }), true);
    const pulled = registry.get('bridge-1');
    assert.match(pulled.last_pull_at, /^\d{4}-\d{2}-\d{2}T/);

    const websocket = registry.register({ worker_id: 'worker-1', subject_id: 'machine:worker-1' });
    assert.equal(websocket.transport, 'websocket');
    assert.equal(websocket.bridge_protocol_version, null);
    assert.equal(websocket.last_pull_at, null);
  } finally {
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
