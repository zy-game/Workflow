// core-db.js - owns core.db schema and migrations.
// v1: tasks + task_events. v2: workers + model_registry.
// v5: persistent model registry revision.
import path from 'node:path';
import { DEFAULT_PRIORITY, PRIORITY_MAX, PRIORITY_MIN } from '@workflow-core/shared';
import { initializeDatabase, transaction } from './base.js';

export const CORE_DB_FILE = 'core.db';
export const CORE_DB_SCHEMA_VERSION = 6;

function createV1(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      brief_json TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK (priority BETWEEN ${PRIORITY_MIN} AND ${PRIORITY_MAX}) DEFAULT ${DEFAULT_PRIORITY},
      status TEXT NOT NULL CHECK (status IN ('queued','dispatched','running','done','failed','blocked','awaiting_input','cancelled')) DEFAULT 'queued',
      created_by TEXT NOT NULL,
      project_id TEXT,
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
    CREATE INDEX IF NOT EXISTS tasks_dispatch_idx ON tasks(status, priority, created_at);
    CREATE INDEX IF NOT EXISTS tasks_worker_idx ON tasks(claim_worker_id);
    CREATE TABLE IF NOT EXISTS task_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      actor TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE (task_id, seq)
    );
    CREATE INDEX IF NOT EXISTS task_events_task_ts_idx ON task_events(task_id, ts);
  `);
}

function createV2(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      worker_id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      machine TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      selector_json TEXT NOT NULL DEFAULT '{}',
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      version TEXT,
      last_seen TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_models_revision INTEGER,
      online INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS model_registry (
      model_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK (priority BETWEEN ${PRIORITY_MIN} AND ${PRIORITY_MAX}) DEFAULT ${DEFAULT_PRIORITY},
      enabled INTEGER NOT NULL DEFAULT 1,
      probe_status TEXT NOT NULL DEFAULT 'unknown',
      probe_latency_ms INTEGER,
      probe_error TEXT,
      probe_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (model, base_url)
    );
    CREATE INDEX IF NOT EXISTS model_registry_order_idx ON model_registry(enabled, priority, model);
  `);
}

function createV3(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS management_decisions (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      topic TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      applied_json TEXT NOT NULL DEFAULT '[]',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS management_decisions_ts_idx ON management_decisions(ts);
  `);
}

function createV4(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_subscriptions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT,
      last_card_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS watch_subscriptions_task_idx ON watch_subscriptions(task_id, active);
    CREATE TABLE IF NOT EXISTS feishu_inbox (
      message_id TEXT PRIMARY KEY,
      chat_id TEXT,
      ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_approvals (
      approval_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tool TEXT,
      risk TEXT,
      reason TEXT,
      chat_id TEXT,
      message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `);
}

function createV5(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_registry_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    ) STRICT;
    INSERT OR IGNORE INTO model_registry_state (singleton, revision)
    VALUES (1, (SELECT count(*) FROM model_registry));
  `);
}

// Approvals raised by the worker's local DSH carry the identifiers needed to
// answer that DSH instance (its mux rpcId + approvalId + sessionId); they are
// persisted so a resolution survives a core restart.
function createV6(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(pending_approvals)').all().map((column) => column.name));
  for (const [column, definition] of [
    ['dsh_approval_id', 'TEXT'],
    ['dsh_rpc_id', 'TEXT'],
    ['dsh_session_id', 'TEXT'],
  ]) {
    if (!existing.has(column)) db.exec(`ALTER TABLE pending_approvals ADD COLUMN ${column} ${definition}`);
  }
}

export function createSchema(db) {
  transaction(db, () => {
    const current = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (current < 1) createV1(db);
    if (current < 2) createV2(db);
    if (current < 3) createV3(db);
    if (current < 4) createV4(db);
    if (current < 5) createV5(db);
    if (current < 6) createV6(db);
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
