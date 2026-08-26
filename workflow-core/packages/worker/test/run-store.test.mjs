import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { RunStore } from '../src/run-store.js';

const stores = [];
afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('outbound frames remain pending until explicitly acknowledged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-run-store-'));
  const store = new RunStore({ dataDir: dir });
  stores.push({ store, dir });
  store.enqueue({ frameId: 'frame-1', type: 'progress', payload: { task_id: 'task-1' } });
  assert.equal(store.pendingFrames()[0].frameId, 'frame-1');
  assert.equal(store.removeFrame('frame-1'), true);
  assert.deepEqual(store.pendingFrames(), []);
});
