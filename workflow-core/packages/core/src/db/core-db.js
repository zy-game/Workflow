// core-db.js - owns the clean-break Workflow Core schema.
import crypto from 'node:crypto';
import path from 'node:path';
import { DEFAULT_PRIORITY, PRIORITY_MAX, PRIORITY_MIN } from '@workflow-core/shared';
import { initializeDatabase, transaction } from './base.js';

export const CORE_DB_FILE = 'core.db';
export const CORE_DB_SCHEMA_VERSION = 18;

// Shared DDL for the peer-sync tables. IF NOT EXISTS keeps it usable for
// fresh schemas, current-version repair, and every migration branch.
const PEER_SYNC_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS peer_nodes (
    node_id TEXT PRIMARY KEY,
    display_name TEXT,
    endpoint_url TEXT,
    protocol_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT,
    public_key TEXT
  );
  CREATE TABLE IF NOT EXISTS peer_sync_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    origin_node_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    sig TEXT
  );
  CREATE INDEX IF NOT EXISTS peer_sync_outbox_origin_idx ON peer_sync_outbox(origin_node_id, seq);
  CREATE TABLE IF NOT EXISTS peer_relay_outbox (
    origin_node_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    sig TEXT,
    PRIMARY KEY (origin_node_id, seq)
  );
  CREATE TABLE IF NOT EXISTS peer_sync_inbox (
    event_id TEXT PRIMARY KEY,
    origin_node_id TEXT NOT NULL,
    origin_seq INTEGER NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','duplicate','conflict','rejected')),
    detail_json TEXT NOT NULL DEFAULT '{}',
    received_at TEXT NOT NULL,
    applied_at TEXT
  );
  CREATE INDEX IF NOT EXISTS peer_sync_inbox_origin_idx ON peer_sync_inbox(origin_node_id, origin_seq);
  CREATE TABLE IF NOT EXISTS peer_sync_cursors (
    peer_node_id TEXT NOT NULL,
    origin_node_id TEXT NOT NULL DEFAULT '',
    inbound_cursor INTEGER NOT NULL DEFAULT 0,
    outbound_acked_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (peer_node_id, origin_node_id)
  );
`;

function createCurrentSchema(db) {
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      brief_json TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK (priority BETWEEN ${PRIORITY_MIN} AND ${PRIORITY_MAX}) DEFAULT ${DEFAULT_PRIORITY},
      status TEXT NOT NULL CHECK (status IN ('queued','dispatched','running','done','failed','blocked','awaiting_input','cancelled')) DEFAULT 'queued',
      created_by TEXT NOT NULL,
      origin_node_id TEXT,
      project_id TEXT,
      executor_node_id TEXT,
      execution_policy_snapshot_json TEXT NOT NULL DEFAULT '{}',
      agent_id TEXT,
      session_ref TEXT,
      backend_kind TEXT,
      requested_backend_kind TEXT,
      required_capabilities_json TEXT NOT NULL DEFAULT '[]',
      execution_policy_json TEXT NOT NULL DEFAULT '{}',
      worker_selector_json TEXT NOT NULL DEFAULT '{}',
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      idempotency_key TEXT,
      claim_token TEXT,
      claim_worker_id TEXT,
      lease_deadline TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      result_kind TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE (created_by, idempotency_key)
    );
    CREATE INDEX tasks_dispatch_idx ON tasks(status, priority, created_at);
    CREATE INDEX tasks_executor_idx ON tasks(executor_node_id, status, priority, created_at);
    CREATE INDEX tasks_worker_idx ON tasks(claim_worker_id, status);

    CREATE TABLE task_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      actor TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE (task_id, seq)
    );
    CREATE INDEX task_events_task_ts_idx ON task_events(task_id, ts);

    CREATE TABLE workers (
      worker_id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      machine TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      selector_json TEXT NOT NULL DEFAULT '{}',
      projects_json TEXT NOT NULL DEFAULT '[]',
      backends_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'running',
      config_revision INTEGER NOT NULL DEFAULT 0,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      version TEXT,
      last_seen TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      online INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      authorized INTEGER NOT NULL DEFAULT 1,
      revoked INTEGER NOT NULL DEFAULT 0,
      transport TEXT,
      last_pull_at TEXT,
      bridge_protocol_version INTEGER
    );
    CREATE TABLE worker_inbound_frames (
      worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
      frame_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (worker_id, frame_id)
    );
    CREATE INDEX workers_state_seen_idx ON workers(state, online, last_seen);

    CREATE TABLE bridge_requests (
      bridge_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      task_id TEXT,
      payload_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      status INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (bridge_id, request_id)
    );
    CREATE INDEX bridge_requests_task_idx ON bridge_requests(task_id, created_at);
    CREATE INDEX bridge_requests_expiry_idx ON bridge_requests(expires_at);

    CREATE TABLE worker_credentials (
      credential_id TEXT PRIMARY KEY,
      worker_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'static',
      secret_encrypted TEXT,
      reference TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX worker_credentials_worker_idx ON worker_credentials(worker_id);

    CREATE TABLE enrollments (
      code TEXT PRIMARY KEY,
      worker_id TEXT,
      machine TEXT,
      fingerprint TEXT,
      token_pending TEXT,
      approved_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized','consumed','revoked')),
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );

    CREATE TABLE worker_skills (
      name TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE interactions (
      interaction_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      worker_id TEXT,
      backend_kind TEXT,
      session_ref TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('question','approval','credential','file_select','control')),
      schema_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('pending','answered','delivered','consumed','expired','cancelled')) DEFAULT 'pending',
      response_id TEXT,
      response_json TEXT,
      answered_by TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      answered_at TEXT,
      delivered_at TEXT,
      consumed_at TEXT
    );
    CREATE INDEX interactions_task_status_idx ON interactions(task_id, status, created_at);
    CREATE INDEX interactions_worker_status_idx ON interactions(worker_id, status, created_at);

    CREATE TABLE project_agents (
      agent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id)
    );
    CREATE INDEX project_agents_project_idx ON project_agents(project_id, status);

    CREATE TABLE watch_subscriptions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT,
      last_card_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX watch_subscriptions_task_idx ON watch_subscriptions(task_id, active);

    CREATE TABLE feishu_inbox (
      message_id TEXT PRIMARY KEY,
      chat_id TEXT,
      ts TEXT NOT NULL
    );

    CREATE TABLE server_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE peer_nodes (
      node_id TEXT PRIMARY KEY,
      display_name TEXT,
      endpoint_url TEXT,
      protocol_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT,
      public_key TEXT
    );

    CREATE TABLE peer_sync_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      origin_node_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      sig TEXT
    );
    CREATE INDEX peer_sync_outbox_origin_idx ON peer_sync_outbox(origin_node_id, seq);

    CREATE TABLE peer_sync_inbox (
      event_id TEXT PRIMARY KEY,
      origin_node_id TEXT NOT NULL,
      origin_seq INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','duplicate','conflict','rejected')),
      detail_json TEXT NOT NULL DEFAULT '{}',
      received_at TEXT NOT NULL,
      applied_at TEXT
    );
    CREATE INDEX peer_sync_inbox_origin_idx ON peer_sync_inbox(origin_node_id, origin_seq);

    CREATE TABLE peer_relay_outbox (
      origin_node_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      sig TEXT,
      PRIMARY KEY (origin_node_id, seq)
    );

    CREATE TABLE peer_sync_cursors (
      peer_node_id TEXT NOT NULL,
      origin_node_id TEXT NOT NULL DEFAULT '',
      inbound_cursor INTEGER NOT NULL DEFAULT 0,
      outbound_acked_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (peer_node_id, origin_node_id)
    );
  `);
}

// v18 cursor shape: inbound/outbound cursors become per (peer, origin)
// streams so one relay can carry many origins' event streams.
function migrateCursorsToOriginStreams(db) {
  const hasOriginColumn = db.prepare('PRAGMA table_info(peer_sync_cursors)').all()
    .some((column) => column.name === 'origin_node_id');
  if (hasOriginColumn) return;
  db.exec(`
    CREATE TABLE peer_sync_cursors_migrated (
      peer_node_id TEXT NOT NULL,
      origin_node_id TEXT NOT NULL DEFAULT '',
      inbound_cursor INTEGER NOT NULL DEFAULT 0,
      outbound_acked_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (peer_node_id, origin_node_id)
    );
    INSERT INTO peer_sync_cursors_migrated
      SELECT peer_node_id, '', inbound_cursor, outbound_acked_seq, updated_at FROM peer_sync_cursors;
    DROP TABLE peer_sync_cursors;
    ALTER TABLE peer_sync_cursors_migrated RENAME TO peer_sync_cursors;
  `);
}

// Current-version repair: prerelease databases may predate the v18 shape.
function repairCursorsTable(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'peer_sync_cursors'").get()) return;
  migrateCursorsToOriginStreams(db);
}

export function createSchema(db) {
  transaction(db, () => {
    const current = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (current === CORE_DB_SCHEMA_VERSION) {
      // Keep schema creation idempotent for databases stamped at the current
      // version by pre-release builds.
      try { db.exec("ALTER TABLE workers ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* exists */ }
      try { db.exec('ALTER TABLE workers ADD COLUMN authorized INTEGER NOT NULL DEFAULT 1'); } catch { /* exists */ }
      try { db.exec('ALTER TABLE workers ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { db.exec('ALTER TABLE workers ADD COLUMN transport TEXT'); } catch { /* exists */ }
      try { db.exec('ALTER TABLE workers ADD COLUMN last_pull_at TEXT'); } catch { /* exists */ }
      try { db.exec('ALTER TABLE workers ADD COLUMN bridge_protocol_version INTEGER'); } catch { /* exists */ }
      try { db.exec("ALTER TABLE enrollments ADD COLUMN fingerprint TEXT"); } catch { /* exists */ }
      try { db.exec("ALTER TABLE enrollments ADD COLUMN token_pending TEXT"); } catch { /* exists */ }
      try { db.exec("ALTER TABLE enrollments ADD COLUMN approved_at TEXT"); } catch { /* exists */ }
      db.exec(`
        CREATE TABLE IF NOT EXISTS bridge_requests (
          bridge_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          task_id TEXT,
          payload_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          status INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (bridge_id, request_id)
        );
        CREATE INDEX IF NOT EXISTS bridge_requests_task_idx ON bridge_requests(task_id, created_at);
        CREATE INDEX IF NOT EXISTS bridge_requests_expiry_idx ON bridge_requests(expires_at);
        CREATE TABLE IF NOT EXISTS worker_credentials (
          credential_id TEXT PRIMARY KEY,
          worker_id TEXT,
          name TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'static',
          secret_encrypted TEXT,
          reference TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS worker_credentials_worker_idx ON worker_credentials(worker_id);
        CREATE TABLE IF NOT EXISTS enrollments (
          code TEXT PRIMARY KEY,
          worker_id TEXT,
          machine TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized','consumed','revoked')),
          created_at TEXT NOT NULL,
          consumed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS worker_skills (
          name TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS server_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'").get()) {
        try { db.exec("ALTER TABLE tasks ADD COLUMN origin_node_id TEXT"); } catch { /* exists */ }
        try { db.exec("ALTER TABLE tasks ADD COLUMN executor_node_id TEXT"); } catch { /* exists */ }
        try { db.exec("ALTER TABLE tasks ADD COLUMN execution_policy_snapshot_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* exists */ }
        db.exec('CREATE INDEX IF NOT EXISTS tasks_executor_idx ON tasks(executor_node_id, status, priority, created_at)');
      }
      db.exec(PEER_SYNC_SCHEMA_SQL);
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'peer_nodes'").get()) {
        try { db.exec('ALTER TABLE peer_nodes ADD COLUMN public_key TEXT'); } catch { /* exists */ }
        try { db.exec('ALTER TABLE peer_sync_outbox ADD COLUMN sig TEXT'); } catch { /* exists */ }
      }
      repairCursorsTable(db);
      return;
    }
    if (current === 17) {
      db.exec(PEER_SYNC_SCHEMA_SQL);
      migrateCursorsToOriginStreams(db);
      db.exec(`PRAGMA user_version = ${CORE_DB_SCHEMA_VERSION}`);
      return;
    }
    if (current === 16) {
      db.exec(PEER_SYNC_SCHEMA_SQL);
      db.exec('ALTER TABLE peer_nodes ADD COLUMN public_key TEXT');
      db.exec('ALTER TABLE peer_sync_outbox ADD COLUMN sig TEXT');
      migrateCursorsToOriginStreams(db);
      db.exec(`PRAGMA user_version = ${CORE_DB_SCHEMA_VERSION}`);
      return;
    }
    if (current === 15) {
      db.exec(PEER_SYNC_SCHEMA_SQL);
      db.exec(`PRAGMA user_version = ${CORE_DB_SCHEMA_VERSION}`);
      return;
    }
    if (current === 14) {
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'").get()) {
        db.exec(`
          ALTER TABLE tasks ADD COLUMN origin_node_id TEXT;
          ALTER TABLE tasks ADD COLUMN executor_node_id TEXT;
          ALTER TABLE tasks ADD COLUMN execution_policy_snapshot_json TEXT NOT NULL DEFAULT '{}';
          CREATE INDEX tasks_executor_idx ON tasks(executor_node_id, status);
          UPDATE tasks SET origin_node_id = COALESCE(origin_node_id, created_by),
            executor_node_id = COALESCE(executor_node_id, created_by),
            execution_policy_snapshot_json = CASE
              WHEN execution_policy_snapshot_json IS NULL OR execution_policy_snapshot_json = '{}'
                THEN COALESCE(execution_policy_json, '{}')
              ELSE execution_policy_snapshot_json
            END;
        `);
      }
      db.exec(PEER_SYNC_SCHEMA_SQL);
      db.exec(`PRAGMA user_version = ${CORE_DB_SCHEMA_VERSION}`);
      return;
    }
    if (current === 13) {
      const activeClaims = db.prepare(`
        SELECT task_id, claim_token
        FROM tasks
        WHERE claim_token IS NOT NULL
          AND status IN ('dispatched','running','awaiting_input')
      `).all();
      const latestClaimEvent = db.prepare(`
        SELECT event_id, payload_json
        FROM task_events
        WHERE task_id = ? AND type = 'claimed'
        ORDER BY seq DESC
        LIMIT 1
      `);
      const updateClaimEvent = db.prepare(
        'UPDATE task_events SET payload_json = ? WHERE event_id = ?',
      );
      for (const claim of activeClaims) {
        const event = latestClaimEvent.get(claim.task_id);
        if (!event) continue;
        const payload = JSON.parse(event.payload_json);
        if (!payload.claim_token_hash) {
          payload.claim_token_hash = crypto
            .createHash('sha256')
            .update(claim.claim_token)
            .digest('hex');
          updateClaimEvent.run(JSON.stringify(payload), event.event_id);
        }
      }
      db.exec(`
        ALTER TABLE workers ADD COLUMN transport TEXT;
        ALTER TABLE workers ADD COLUMN last_pull_at TEXT;
        ALTER TABLE workers ADD COLUMN bridge_protocol_version INTEGER;
        ALTER TABLE tasks ADD COLUMN origin_node_id TEXT;
        ALTER TABLE tasks ADD COLUMN executor_node_id TEXT;
        ALTER TABLE tasks ADD COLUMN execution_policy_snapshot_json TEXT NOT NULL DEFAULT '{}';
        CREATE INDEX tasks_executor_idx ON tasks(executor_node_id, status);
        CREATE TABLE bridge_requests (
          bridge_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          task_id TEXT,
          payload_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          status INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (bridge_id, request_id)
        );
        CREATE INDEX bridge_requests_task_idx ON bridge_requests(task_id, created_at);
        CREATE INDEX bridge_requests_expiry_idx ON bridge_requests(expires_at);
        CREATE TABLE server_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = ${CORE_DB_SCHEMA_VERSION};
      `);
      db.exec(PEER_SYNC_SCHEMA_SQL);
      return;
    }
    if (current !== 0) {
      const error = new Error(
        `unsupported core.db schema version ${current}; expected ${CORE_DB_SCHEMA_VERSION}. Create a new data directory for this clean-break release`,
      );
      error.code = 'UNSUPPORTED_CORE_SCHEMA';
      throw error;
    }
    createCurrentSchema(db);
    db.exec(`PRAGMA user_version = ${CORE_DB_SCHEMA_VERSION}`);
  });
}

export class CoreDatabase {
  constructor({ dataDir, dbFile, busyTimeoutMs } = {}) {
    const dir = path.resolve(dataDir);
    this.file = path.resolve(dbFile || path.join(dir, CORE_DB_FILE));
    this.db = initializeDatabase(this.file, CORE_DB_SCHEMA_VERSION, createSchema, { busyTimeoutMs });
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  integrityCheck() {
    const integrity = this.db.prepare('PRAGMA integrity_check').get();
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all();
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    return {
      ok: integrity.integrity_check === 'ok' && foreignKeys.length === 0 && version === CORE_DB_SCHEMA_VERSION,
      version,
    };
  }
}
