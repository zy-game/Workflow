import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadNodeIdentity, normalizeNodeId } from '../src/node-identity.js';

test('node identity persists across restarts and accepts an explicit first value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-node-id-'));
  try {
    const first = loadNodeIdentity({ dataDir: dir, nodeId: 'node-primary' });
    const second = loadNodeIdentity({ dataDir: dir });
    assert.equal(first.nodeId, 'node-primary');
    assert.equal(second.nodeId, first.nodeId);
    assert.equal(second.generated, false);
    assert.equal(fs.readFileSync(first.file, 'utf8'), 'node-primary\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('node identity generates a stable opaque id and rejects mismatched configuration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-node-id-'));
  try {
    const first = loadNodeIdentity({ dataDir: dir });
    assert.match(first.nodeId, /^node-[a-f0-9]{24}$/);
    assert.throws(() => loadNodeIdentity({ dataDir: dir, nodeId: 'node-other' }), (error) => error?.code === 'NODE_ID_MISMATCH');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('node identity validates logical ids without exposing filesystem details', () => {
  assert.equal(normalizeNodeId('node-a_1'), 'node-a_1');
  for (const value of ['', 'A-node', 'node/x', 'node-中文', 'x']) {
    assert.throws(() => normalizeNodeId(value), /node_id/);
  }
});
