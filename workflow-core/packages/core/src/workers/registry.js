// registry.js - worker registration and liveness over core.db.
// Heartbeats refresh last_seen; dispatch always reads the current record.
export const WORKER_OFFLINE_MS = 60 * 1000;

const WORKER_STATES = new Set(['running', 'draining', 'offline']);
const WORKER_TRANSPORTS = new Set(['websocket', 'pull']);

function normalizeProjects(projects) {
  if (!Array.isArray(projects)) throw new TypeError('projects must be an array');
  return [...new Set(projects.map((project) => {
    if (typeof project === 'string') return project;
    if (project && typeof project.project_id === 'string') return project.project_id;
    throw new TypeError('project entries must have a project_id');
  }).filter(Boolean))];
}

function normalizeBackends(backends) {
  if (!Array.isArray(backends)) throw new TypeError('backends must be an array');
  const seen = new Set();
  return backends.map((backend) => {
    if (!backend || typeof backend !== 'object' || Array.isArray(backend)) {
      throw new TypeError('backend descriptors must be objects');
    }
    const kind = String(backend.kind || '');
    if (!kind) throw new TypeError('backend kind is required');
    if (seen.has(kind)) throw new TypeError(`duplicate backend kind: ${kind}`);
    seen.add(kind);
    if (!Array.isArray(backend.capabilities)) throw new TypeError('backend capabilities must be an array');
    return {
      ...backend,
      kind,
      capabilities: [...new Set(backend.capabilities.map(String).filter(Boolean))],
    };
  });
}

export class WorkersRegistry {
  constructor({ coreDb, db, offlineMs = WORKER_OFFLINE_MS } = {}) {
    this.db = db || coreDb.db;
    this.offlineMs = offlineMs;
  }

  register({
    worker_id, subject_id, machine = null, capabilities = [], selector = {},
    projects = [], backends = [], state = 'running', config_revision = 0,
    max_concurrency = 1, version = null, transport = 'websocket',
    bridge_protocol_version = null,
  }) {
    if (!worker_id || typeof worker_id !== 'string') throw new TypeError('worker_id is required');
    if (!subject_id || typeof subject_id !== 'string') throw new TypeError('subject_id is required');
    if (!Array.isArray(capabilities)) throw new TypeError('capabilities must be an array');
    if (!WORKER_STATES.has(state)) throw new TypeError(`invalid worker state: ${state}`);
    if (!WORKER_TRANSPORTS.has(transport)) throw new TypeError(`invalid worker transport: ${transport}`);
    const protocolVersion = bridge_protocol_version === null ? null : Number(bridge_protocol_version);
    if (protocolVersion !== null && (!Number.isInteger(protocolVersion) || protocolVersion < 1)) {
      throw new TypeError('bridge_protocol_version must be a positive integer or null');
    }
    if (transport !== 'pull' && protocolVersion !== null) {
      throw new TypeError('bridge_protocol_version is only valid for pull transport');
    }
    const concurrency = Number(max_concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new TypeError('max_concurrency must be an integer 1-32');
    }
    const revision = Number(config_revision);
    if (!Number.isInteger(revision) || revision < 0) throw new TypeError('config_revision must be a non-negative integer');
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workers (
        worker_id, subject_id, machine, capabilities_json, selector_json,
        projects_json, backends_json, state, config_revision,
        max_concurrency, version, last_seen, registered_at, online,
        transport, bridge_protocol_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET
        subject_id = excluded.subject_id, machine = excluded.machine,
        capabilities_json = excluded.capabilities_json, selector_json = excluded.selector_json,
        projects_json = excluded.projects_json, backends_json = excluded.backends_json,
        state = excluded.state, config_revision = excluded.config_revision,
        max_concurrency = excluded.max_concurrency, version = excluded.version,
        last_seen = excluded.last_seen, online = 1,
        transport = excluded.transport,
        bridge_protocol_version = excluded.bridge_protocol_version
    `).run(
      worker_id, subject_id, machine,
      JSON.stringify([...new Set(capabilities.map(String).filter(Boolean))]),
      JSON.stringify(selector ?? {}), JSON.stringify(normalizeProjects(projects)),
      JSON.stringify(normalizeBackends(backends)), state, revision,
      concurrency, version, now, now, transport, protocolVersion,
    );
    return this.get(worker_id);
  }

  heartbeat(workerId, { state = null, pulled = false } = {}) {
    if (state !== null && !WORKER_STATES.has(state)) throw new TypeError(`invalid worker state: ${state}`);
    if (typeof pulled !== 'boolean') throw new TypeError('pulled must be a boolean');
    const now = new Date().toISOString();
    const result = state === null
      ? this.db.prepare(`
          UPDATE workers SET last_seen = ?, online = 1,
            last_pull_at = CASE WHEN ? = 1 THEN ? ELSE last_pull_at END
          WHERE worker_id = ?
        `).run(now, pulled ? 1 : 0, now, workerId)
      : this.db.prepare(`
          UPDATE workers SET last_seen = ?, online = 1, state = ?,
            last_pull_at = CASE WHEN ? = 1 THEN ? ELSE last_pull_at END
          WHERE worker_id = ?
        `).run(now, state, pulled ? 1 : 0, now, workerId);
    return result.changes > 0;
  }

  markDisconnected(workerId) {
    this.db.prepare("UPDATE workers SET online = 0, state = 'offline' WHERE worker_id = ?").run(workerId);
  }

  hasInboundFrame(workerId, frameId) {
    if (!workerId || !frameId) return false;
    return Boolean(this.db.prepare(
      'SELECT 1 AS found FROM worker_inbound_frames WHERE worker_id = ? AND frame_id = ?',
    ).get(workerId, frameId));
  }

  serverConfig(workerId) {
    const row = this.db.prepare('SELECT config_json, config_revision FROM workers WHERE worker_id = ?').get(workerId);
    if (!row) return null;
    let config = {};
    try { config = JSON.parse(row.config_json || '{}'); } catch { /* keep empty */ }
    return { ...config, revision: Number(row.config_revision || 0) };
  }

  saveServerConfig(workerId, patch) {
    const current = this.serverConfig(workerId) ?? {};
    const next = { ...current, ...patch };
    const revision = Number(current.revision || 0) + 1;
    const result = this.db.prepare(
      'UPDATE workers SET config_json = ?, config_revision = ? WHERE worker_id = ?',
    ).run(JSON.stringify({ ...next, revision }), revision, workerId);
    if (result.changes === 0) throw new Error(`worker does not exist: ${workerId}`);
    return { ...next, revision };
  }

  revoke(workerId, reason = null) {
    // The reason stays out of config_json (which is worker-facing config);
    // it is recorded only in the audit-visible database state.
    const result = this.db.prepare(
      "UPDATE workers SET revoked = 1, state = 'offline', online = 0 WHERE worker_id = ?",
    ).run(workerId);
    return result.changes > 0;
  }

  isRevoked(workerId) {
    const row = this.db.prepare('SELECT revoked FROM workers WHERE worker_id = ?').get(workerId);
    return Boolean(row && Number(row.revoked) === 1);
  }

  unrevoke(workerId) {
    const result = this.db.prepare(
      "UPDATE workers SET revoked = 0, state = 'running', config_json = json_remove(COALESCE(config_json,'{}'), '$.revoke_reason') WHERE worker_id = ?",
    ).run(workerId);
    return result.changes > 0;
  }

  setCredential({ credentialId, workerId, name, kind = 'static', secretEncrypted = null, reference = null, metadata = {} }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO worker_credentials (credential_id, worker_id, name, kind, secret_encrypted, reference, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET
        worker_id = excluded.worker_id, name = excluded.name, kind = excluded.kind,
        secret_encrypted = excluded.secret_encrypted, reference = excluded.reference,
        metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
    `).run(credentialId, workerId, String(name), kind, secretEncrypted, reference, JSON.stringify(metadata), now);
    return this.getCredential(credentialId);
  }

  getCredential(credentialId) {
    const row = this.db.prepare('SELECT * FROM worker_credentials WHERE credential_id = ?').get(credentialId);
    return row ? this.#credentialFromRow(row) : null;
  }

  listCredentials(workerId = null) {
    const rows = workerId
      ? this.db.prepare('SELECT * FROM worker_credentials WHERE worker_id = ? ORDER BY updated_at, credential_id').all(workerId)
      : this.db.prepare('SELECT * FROM worker_credentials ORDER BY updated_at, credential_id').all();
    return rows.map((row) => this.#credentialFromRow(row));
  }

  deleteCredential(credentialId) {
    return this.db.prepare('DELETE FROM worker_credentials WHERE credential_id = ?').run(credentialId).changes > 0;
  }

  #credentialFromRow(row) {
    return {
      credentialId: row.credential_id,
      workerId: row.worker_id,
      name: row.name,
      kind: row.kind,
      secretEncrypted: row.secret_encrypted,
      reference: row.reference,
      metadata: JSON.parse(row.metadata_json || '{}'),
      updatedAt: row.updated_at,
    };
  }

  // Device-first enrollment: a worker registers itself with a device
  // fingerprint and waits for admin approval on the console.
  deviceRegister({ workerId, machine = null, fingerprint = null }) {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT * FROM enrollments WHERE code = ?').get(workerId);
    if (existing && existing.status === 'consumed' && existing.fingerprint === fingerprint) return this.getEnrollment(workerId);
    if (existing && (existing.status === 'authorized' || existing.status === 'consumed') && existing.fingerprint !== fingerprint) {
      throw new Error('device identity conflict: worker_id already enrolled with a different fingerprint');
    }
    this.db.prepare(`
      INSERT INTO enrollments (code, worker_id, machine, fingerprint, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(code) DO UPDATE SET
        machine = excluded.machine, fingerprint = excluded.fingerprint,
        status = CASE WHEN enrollments.status = 'revoked' THEN 'pending' ELSE enrollments.status END
    `).run(workerId, workerId, machine, fingerprint, now);
    return this.getEnrollment(workerId);
  }

  deviceApprove(workerId, token) {
    const existing = this.getEnrollment(workerId);
    if (!existing || existing.status !== 'pending') throw new Error('device is not awaiting approval');
    this.db.prepare("UPDATE enrollments SET status = 'authorized', token_pending = ?, approved_at = ? WHERE code = ?")
      .run(String(token), new Date().toISOString(), workerId);
    return this.getEnrollment(workerId);
  }

  devicePoll(workerId, fingerprint) {
    const existing = this.getEnrollment(workerId);
    if (!existing || existing.fingerprint !== fingerprint) return { state: 'unknown' };
    if (existing.status === 'pending') return { state: 'pending' };
    if (existing.status === 'authorized' && existing.hasTokenPending) {
      const token = this.encode; void token;
      const row = this.db.prepare('SELECT token_pending FROM enrollments WHERE code = ?').get(workerId);
      this.db.prepare("UPDATE enrollments SET status = 'consumed', token_pending = NULL, consumed_at = ? WHERE code = ?")
        .run(new Date().toISOString(), workerId);
      return { state: 'authorized', token: String(row.token_pending) };
    }
    if (existing.status === 'consumed') return { state: 'consumed' };
    if (existing.status === 'revoked') return { state: 'revoked' };
    return { state: existing.status };
  }
  createEnrollment({ code, workerId = null, machine = null }) {
    this.db.prepare('INSERT INTO enrollments (code, worker_id, machine, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(code, workerId, machine, 'pending', new Date().toISOString());
    return this.getEnrollment(code);
  }

  getEnrollment(code) {
    const row = this.db.prepare('SELECT * FROM enrollments WHERE code = ?').get(code);
    if (!row) return null;
    return { code: row.code, workerId: row.worker_id, machine: row.machine, fingerprint: row.fingerprint, hasTokenPending: Boolean(row.token_pending), approvedAt: row.approved_at, status: row.status, createdAt: row.created_at, consumedAt: row.consumed_at };
  }

  listEnrollments() {
    return this.db.prepare('SELECT * FROM enrollments ORDER BY created_at DESC').all()
      .map((row) => ({ code: row.code, workerId: row.worker_id, machine: row.machine, fingerprint: row.fingerprint, hasTokenPending: Boolean(row.token_pending), approvedAt: row.approved_at, status: row.status, createdAt: row.created_at, consumedAt: row.consumed_at }));
  }

  consumeEnrollment(code, { workerId, machine = null }) {
    const enrollment = this.getEnrollment(code);
    if (!enrollment || enrollment.status !== 'pending') return null;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE enrollments SET status = 'consumed', worker_id = ?, machine = COALESCE(?, machine), consumed_at = ? WHERE code = ?")
      .run(workerId, machine, now, code);
    return this.getEnrollment(code);
  }

  revokeEnrollment(code) {
    return this.db.prepare("UPDATE enrollments SET status = 'revoked' WHERE code = ?").run(code).changes > 0;
  }

  listSkills() {
    return this.db.prepare('SELECT * FROM worker_skills ORDER BY name').all()
      .map((row) => ({ name: row.name, content: row.content, version: Number(row.version), updatedAt: row.updated_at }));
  }

  upsertSkill(name, content) {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT version FROM worker_skills WHERE name = ?').get(name);
    const version = existing ? Number(existing.version) + 1 : 1;
    this.db.prepare(`
      INSERT INTO worker_skills (name, content, version, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET content = excluded.content, version = excluded.version, updated_at = excluded.updated_at
    `).run(name, String(content ?? ''), version, now);
    return { name, content: String(content ?? ''), version, updatedAt: now };
  }

  deleteSkill(name) {
    return this.db.prepare('DELETE FROM worker_skills WHERE name = ?').run(name).changes > 0;
  }

  recordInboundFrame(workerId, frameId) {
    if (!workerId || !frameId) return false;
    const result = this.db.prepare(`
      INSERT INTO worker_inbound_frames (worker_id, frame_id, received_at)
      VALUES (?, ?, ?)
      ON CONFLICT(worker_id, frame_id) DO NOTHING
    `).run(workerId, frameId, new Date().toISOString());
    return result.changes > 0;
  }

  get(workerId, now = Date.now()) {
    return this.#rowToWorker(this.db.prepare('SELECT * FROM workers WHERE worker_id = ?').get(workerId), now);
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
      projects: JSON.parse(row.projects_json || '[]'),
      backends: JSON.parse(row.backends_json || '[]'),
      state: row.state || 'running',
      config_revision: Number(row.config_revision || 0),
      max_concurrency: Number(row.max_concurrency),
      version: row.version,
      transport: row.transport || 'websocket',
      last_pull_at: row.last_pull_at,
      bridge_protocol_version: row.bridge_protocol_version === null ? null : Number(row.bridge_protocol_version),
      last_seen: row.last_seen,
      registered_at: row.registered_at,
      connected: Number(row.online) === 1,
      fresh: Number.isFinite(lastSeenMs) && now - lastSeenMs < this.offlineMs,
      authorized: Number(row.authorized ?? 1) === 1,
      revoked: Number(row.revoked ?? 0) === 1,
      serverConfig: this.serverConfig(row.worker_id),
    };
  }
}
