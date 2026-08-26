// core-db.js - owns the clean-break Workflow Core schema.
import path from 'node:path';
import { DEFAULT_PRIORITY, PRIORITY_MAX, PRIORITY_MIN } from '@workflow-core/shared';
import { initializeDatabase, transaction } from './base.js';

export const CORE_DB_FILE = 'core.db';
export const CORE_DB_SCHEMA_VERSION = 13;

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
      project_id TEXT,
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
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE worker_inbound_frames (
      worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
      frame_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (worker_id, frame_id)
    );
    CREATE INDEX workers_state_seen_idx ON workers(state, online, last_seen);

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
  `);
}

export function createSchema(db) {
  transaction(db, () => {
    const current = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (current === CORE_DB_SCHEMA_VERSION) {
      // In-place lightweight upgrade for databases already at 13: add the
      // worker-management columns and tables if absent. The clean-break rule
      // for older schemas is unchanged.
      try { db.exec("ALTER TABLE workers ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* exists */ }
      try { db.exec('ALTER TABLE workers ADD COLUMN authorized INTEGER NOT NULL DEFAULT 1'); } catch { /* exists */ }
      try { db.exec('ALTER TABLE workers ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { db.exec("ALTER TABLE enrollments ADD COLUMN fingerprint TEXT"); } catch { /* exists */ }
      try { db.exec("ALTER TABLE enrollments ADD COLUMN token_pending TEXT"); } catch { /* exists */ }
      try { db.exec("ALTER TABLE enrollments ADD COLUMN approved_at TEXT"); } catch { /* exists */ }
      db.exec(`
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
      `);
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
