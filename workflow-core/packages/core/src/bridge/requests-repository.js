import crypto from 'node:crypto';
import { transaction } from '../db/base.js';

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('bridge payload numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('bridge payload must not be circular');
    seen.add(value);
    const result = `[${value.map((entry) => canonicalize(entry, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value !== 'object') throw new TypeError('bridge payload must contain only JSON values');
  if (seen.has(value)) throw new TypeError('bridge payload must not be circular');
  seen.add(value);
  const result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

export function canonicalPayloadHash(payload) {
  return crypto.createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
}

function requireString(value, name) {
  if (!value || typeof value !== 'string') throw new TypeError(`${name} is required`);
  return value;
}

function parseResponse(value) {
  return JSON.parse(value);
}

export class BridgeRequestConflictError extends Error {
  constructor({ bridgeId, requestId, operation }) {
    super(`bridge request conflicts with stored request: ${bridgeId}/${requestId}`);
    this.name = 'BridgeRequestConflictError';
    this.code = 'BRIDGE_REQUEST_CONFLICT';
    this.bridgeId = bridgeId;
    this.requestId = requestId;
    this.operation = operation;
  }
}

export const DEFAULT_BRIDGE_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class BridgeRequestsRepository {
  constructor({ coreDb, db, requestTtlMs = DEFAULT_BRIDGE_REQUEST_TTL_MS } = {}) {
    this.db = db || coreDb?.db;
    if (!this.db) throw new TypeError('coreDb or db is required');
    if (!Number.isInteger(requestTtlMs) || requestTtlMs < 1) throw new TypeError('requestTtlMs must be a positive integer');
    this.requestTtlMs = requestTtlMs;
  }

  execute({ bridgeId, requestId, operation, taskId = null, payload }, mutation) {
    requireString(bridgeId, 'bridgeId');
    requireString(requestId, 'requestId');
    requireString(operation, 'operation');
    if (taskId !== null && typeof taskId !== 'string') throw new TypeError('taskId must be a string or null');
    if (typeof mutation !== 'function') throw new TypeError('mutation must be a function');
    const payloadHash = canonicalPayloadHash(payload);

    return transaction(this.db, () => {
      const existing = this.db.prepare(
        'SELECT * FROM bridge_requests WHERE bridge_id = ? AND request_id = ?',
      ).get(bridgeId, requestId);
      if (existing) {
        if (existing.operation !== operation || existing.task_id !== taskId || existing.payload_hash !== payloadHash) {
          throw new BridgeRequestConflictError({ bridgeId, requestId, operation });
        }
        return { response: parseResponse(existing.response_json), status: Number(existing.status), replayed: true };
      }

      const outcome = mutation();
      if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
        throw new TypeError('bridge mutation must return { response, status }');
      }
      const status = Number(outcome.status);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new TypeError('bridge mutation status must be an HTTP status integer');
      }
      const responseJson = JSON.stringify(outcome.response);
      if (responseJson === undefined) throw new TypeError('bridge mutation response must be JSON serializable');
      const now = new Date();
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + this.requestTtlMs).toISOString();
      this.db.prepare(`
        INSERT INTO bridge_requests (
          bridge_id, request_id, operation, task_id, payload_hash, response_json, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(bridgeId, requestId, operation, taskId, payloadHash, responseJson, status, createdAt, expiresAt);
      return { response: outcome.response, status, replayed: false };
    });
  }

  get(bridgeId, requestId) {
    const row = this.db.prepare(
      'SELECT * FROM bridge_requests WHERE bridge_id = ? AND request_id = ?',
    ).get(bridgeId, requestId);
    if (!row) return null;
    return {
      bridgeId: row.bridge_id,
      requestId: row.request_id,
      operation: row.operation,
      taskId: row.task_id,
      payloadHash: row.payload_hash,
      response: parseResponse(row.response_json),
      status: Number(row.status),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  pruneExpired({ now = new Date().toISOString(), limit = 1000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    return this.db.prepare(`
      DELETE FROM bridge_requests
      WHERE rowid IN (
        SELECT rowid FROM bridge_requests WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
      )
    `).run(now, limit).changes;
  }
}
