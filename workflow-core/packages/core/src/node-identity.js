// node-identity.js - stable logical identity for a Workflow Core instance.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const NODE_ID_FILE = 'node-id';
export const NODE_ID_PATTERN = /^[a-z][a-z0-9._-]{2,63}$/;

export function normalizeNodeId(value) {
  const nodeId = String(value ?? '').trim();
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new TypeError('node_id must match ^[a-z][a-z0-9._-]{2,63}$');
  }
  return nodeId;
}

function generatedNodeId(randomBytes = crypto.randomBytes(12)) {
  return `node-${Buffer.from(randomBytes).toString('hex')}`;
}

export function loadNodeIdentity({ dataDir, nodeId = null, filename = null } = {}) {
  if (!dataDir) throw new TypeError('dataDir is required');
  const file = path.resolve(filename || path.join(dataDir, NODE_ID_FILE));
  const configured = nodeId == null || String(nodeId).trim() === '' ? null : normalizeNodeId(nodeId);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (fs.existsSync(file)) {
    const persisted = normalizeNodeId(fs.readFileSync(file, 'utf8'));
    if (configured && configured !== persisted) {
      const error = new Error('configured node_id does not match the persisted node identity');
      error.code = 'NODE_ID_MISMATCH';
      throw error;
    }
    return { nodeId: persisted, file, generated: false };
  }

  const resolved = configured || generatedNodeId();
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${resolved}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.renameSync(temporary, file); } catch (error) {
      if (!fs.existsSync(file)) throw error;
      fs.rmSync(temporary, { force: true });
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  const persisted = normalizeNodeId(fs.readFileSync(file, 'utf8'));
  if (persisted !== resolved) {
    const error = new Error('node identity changed while it was being initialized');
    error.code = 'NODE_ID_RACE';
    throw error;
  }
  return { nodeId: persisted, file, generated: !configured };
}
