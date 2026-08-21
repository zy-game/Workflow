// registry.js - worker registration and liveness over core.db.
// Heartbeats refresh last_seen; the dispatcher treats a worker as online when
// its WS session is connected AND its record is fresh.
export const WORKER_OFFLINE_MS = 60 * 1000;

export class WorkersRegistry {
  constructor({ coreDb, db, offlineMs = WORKER_OFFLINE_MS } = {}) {
    this.db = db || coreDb.db;
    this.offlineMs = offlineMs;
  }

  register({ worker_id, subject_id, machine = null, capabilities = [], selector = {}, max_concurrency = 1, version = null }) {
    if (!worker_id || typeof worker_id !== 'string') throw new TypeError('worker_id is required');
    if (!subject_id || typeof subject_id !== 'string') throw new TypeError('subject_id is required');
    const concurrency = Number(max_concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new TypeError('max_concurrency must be an integer 1-32');
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workers (
        worker_id, subject_id, machine, capabilities_json, selector_json,
        max_concurrency, version, last_seen, registered_at, online
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(worker_id) DO UPDATE SET
        subject_id = excluded.subject_id, machine = excluded.machine,
        capabilities_json = excluded.capabilities_json, selector_json = excluded.selector_json,
        max_concurrency = excluded.max_concurrency, version = excluded.version,
        last_seen = excluded.last_seen, online = 1
    `).run(
      worker_id, subject_id, machine,
      JSON.stringify([...new Set(capabilities)]), JSON.stringify(selector ?? {}),
      concurrency, version, now, now,
    );
    return this.get(worker_id);
  }

  heartbeat(workerId) {
    const changes = this.db.prepare('UPDATE workers SET last_seen = ?, online = 1 WHERE worker_id = ?')
      .run(new Date().toISOString(), workerId).changes;
    return changes > 0;
  }

  markDisconnected(workerId) {
    this.db.prepare('UPDATE workers SET online = 0 WHERE worker_id = ?').run(workerId);
  }

  recordModelsAck(workerId, revision) {
    this.db.prepare('UPDATE workers SET last_models_revision = ? WHERE worker_id = ?')
      .run(Number(revision) || 0, workerId);
  }

  get(workerId) {
    return this.#rowToWorker(this.db.prepare('SELECT * FROM workers WHERE worker_id = ?').get(workerId));
  }

  list({ onlineOnly = false } = {}) {
    const rows = onlineOnly
      ? this.db.prepare('SELECT * FROM workers WHERE online = 1 ORDER BY worker_id').all()
      : this.db.prepare('SELECT * FROM workers ORDER BY worker_id').all();
    const now = Date.now();
    return rows.map((row) => this.#rowToWorker(row, now));
  }

  #rowToWorker(row, now = Date.now()) {
    if (!row) return null;
    const lastSeenMs = Date.parse(row.last_seen);
    return {
      worker_id: row.worker_id,
      subject_id: row.subject_id,
      machine: row.machine,
      capabilities: JSON.parse(row.capabilities_json || '[]'),
      selector: JSON.parse(row.selector_json || '{}'),
      max_concurrency: Number(row.max_concurrency),
      version: row.version,
      last_seen: row.last_seen,
      registered_at: row.registered_at,
      last_models_revision: row.last_models_revision === null ? null : Number(row.last_models_revision),
      connected: Number(row.online) === 1,
      fresh: Number.isFinite(lastSeenMs) && now - lastSeenMs < this.offlineMs,
    };
  }
}
