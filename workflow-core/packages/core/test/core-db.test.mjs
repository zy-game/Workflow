import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CORE_DB_SCHEMA_VERSION, CoreDatabase } from '../src/db/core-db.js';

test('fresh Core schema contains only Worker execution state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-core-schema-'));
  const core = new CoreDatabase({ dataDir: dir });
  try {
    assert.equal(CORE_DB_SCHEMA_VERSION, 17);
    assert.deepEqual(core.integrityCheck(), { ok: true, version: 17 });

    const tables = new Set(core.db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => row.name));
    for (const required of ['tasks', 'workers', 'interactions', 'task_events', 'bridge_requests', 'server_settings', 'peer_nodes', 'peer_sync_outbox', 'peer_sync_inbox', 'peer_sync_cursors']) {
      assert.ok(tables.has(required), `missing ${required}`);
    }
    for (const obsolete of ['pending_approvals', 'cli_clients', 'cli_conversations']) {
      assert.equal(tables.has(obsolete), false, `unexpected ${obsolete}`);
    }

    const taskColumns = new Set(core.db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name));
    for (const obsolete of ['client_id', 'executor_kind', 'conversation_id', 'workspace']) {
      assert.equal(taskColumns.has(obsolete), false, `unexpected tasks.${obsolete}`);
    }
    const workerColumns = new Set(core.db.prepare('PRAGMA table_info(workers)').all().map((row) => row.name));
    assert.equal(workerColumns.has('last_models_revision'), false);
    for (const required of ['transport', 'last_pull_at', 'bridge_protocol_version']) {
      assert.equal(workerColumns.has(required), true, `missing workers.${required}`);
    }
  } finally {
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Core repairs server settings on a current-version database from a pre-release build', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-core-current-schema-'));
  const file = path.join(dir, 'core.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE workers (worker_id TEXT PRIMARY KEY);
    CREATE TABLE enrollments (code TEXT PRIMARY KEY);
    PRAGMA user_version = 17;
  `);
  old.close();
  const core = new CoreDatabase({ dataDir: dir });
  try {
    assert.deepEqual(core.integrityCheck(), { ok: true, version: CORE_DB_SCHEMA_VERSION });
    assert.ok(core.db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'server_settings'",
    ).get());
    for (const table of ['peer_nodes', 'peer_sync_outbox', 'peer_sync_inbox', 'peer_sync_cursors']) {
      assert.ok(core.db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ).get(table), `missing ${table}`);
    }
  } finally {
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Core migrates v15 peer sync tables and preserves task data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-core-v15-schema-'));
  const file = path.join(dir, 'core.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      origin_node_id TEXT,
      project_id TEXT,
      executor_node_id TEXT,
      execution_policy_snapshot_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO tasks(task_id, status, created_by, origin_node_id, project_id, executor_node_id, execution_policy_snapshot_json)
      VALUES ('task-v15', 'done', 'account:legacy', 'node-origin', 'proj-1', 'node-owner', '{"mode":"kept"}');
    PRAGMA user_version = 15;
  `);
  old.close();
  const core = new CoreDatabase({ dataDir: dir });
  try {
    assert.deepEqual(core.integrityCheck(), { ok: true, version: CORE_DB_SCHEMA_VERSION });
    const task = core.db.prepare('SELECT origin_node_id, executor_node_id, execution_policy_snapshot_json FROM tasks WHERE task_id = ?').get('task-v15');
    assert.equal(task.origin_node_id, 'node-origin');
    assert.equal(task.executor_node_id, 'node-owner');
    assert.deepEqual(JSON.parse(task.execution_policy_snapshot_json), { mode: 'kept' });
    for (const table of ['peer_nodes', 'peer_sync_outbox', 'peer_sync_inbox', 'peer_sync_cursors']) {
      assert.ok(core.db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ).get(table), `missing ${table}`);
    }
  } finally {
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Core migrates v16 peer sync tables to the signed-event columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-core-v16-schema-'));
  const file = path.join(dir, 'core.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE peer_nodes (
      node_id TEXT PRIMARY KEY,
      display_name TEXT,
      endpoint_url TEXT,
      protocol_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT
    );
    CREATE TABLE peer_sync_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      origin_node_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    INSERT INTO peer_nodes(node_id, display_name, created_at, updated_at)
      VALUES ('node-beta', 'beta', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 16;
  `);
  old.close();
  const core = new CoreDatabase({ dataDir: dir });
  try {
    assert.deepEqual(core.integrityCheck(), { ok: true, version: CORE_DB_SCHEMA_VERSION });
    const peerColumns = new Set(core.db.prepare('PRAGMA table_info(peer_nodes)').all().map((row) => row.name));
    const outboxColumns = new Set(core.db.prepare('PRAGMA table_info(peer_sync_outbox)').all().map((row) => row.name));
    assert.equal(peerColumns.has('public_key'), true, 'missing peer_nodes.public_key');
    assert.equal(outboxColumns.has('sig'), true, 'missing peer_sync_outbox.sig');
    assert.equal(core.db.prepare('SELECT public_key FROM peer_nodes WHERE node_id = ?').get('node-beta').public_key, null);
  } finally {
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Core migrates v13 Worker data to the Bridge-capable schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-core-v13-schema-'));
  const file = path.join(dir, 'core.db');
  const old = new DatabaseSync(file);
  old.exec(`
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
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      claim_token TEXT
    );
    CREATE TABLE task_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    INSERT INTO workers(worker_id, subject_id, last_seen, registered_at) VALUES ('worker-1', 'machine:worker-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO tasks(task_id, status, claim_token) VALUES ('task-1', 'running', 'legacy-claim-token');
    INSERT INTO task_events(event_id, task_id, seq, type, payload_json)
      VALUES ('event-1', 'task-1', 0, 'claimed', '{"worker_id":"worker-1"}');
    PRAGMA user_version = 13;
  `);
  old.close();
  const core = new CoreDatabase({ dataDir: dir });
  try {
    assert.deepEqual(core.integrityCheck(), { ok: true, version: CORE_DB_SCHEMA_VERSION });
    const worker = core.db.prepare('SELECT transport, last_pull_at, bridge_protocol_version FROM workers WHERE worker_id = ?').get('worker-1');
    assert.equal(worker.transport, null);
    assert.equal(worker.last_pull_at, null);
    assert.equal(worker.bridge_protocol_version, null);
    assert.ok(core.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'bridge_requests'").get());
    const claimPayload = JSON.parse(core.db.prepare(
      "SELECT payload_json FROM task_events WHERE task_id = 'task-1' AND type = 'claimed'",
    ).get().payload_json);
    assert.equal(
      claimPayload.claim_token_hash,
      crypto.createHash('sha256').update('legacy-claim-token').digest('hex'),
    );
  } finally {
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Core migrates v14 task routing fields and preserves legacy ownership fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-core-v14-schema-'));
  const file = path.join(dir, 'core.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      project_id TEXT,
      execution_policy_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO tasks(task_id, status, created_by, execution_policy_json)
      VALUES ('task-v14', 'done', 'account:legacy', '{"mode":"legacy"}');
    PRAGMA user_version = 14;
  `);
  old.close();
  const core = new CoreDatabase({ dataDir: dir });
  try {
    assert.deepEqual(core.integrityCheck(), { ok: true, version: CORE_DB_SCHEMA_VERSION });
    const task = core.db.prepare('SELECT origin_node_id, project_id, executor_node_id, execution_policy_snapshot_json FROM tasks WHERE task_id = ?').get('task-v14');
    assert.equal(task.origin_node_id, 'account:legacy');
    assert.equal(task.project_id, null);
    assert.equal(task.executor_node_id, 'account:legacy');
    assert.deepEqual(JSON.parse(task.execution_policy_snapshot_json), { mode: 'legacy' });
  } finally {
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('Core rejects unsupported legacy databases instead of partially migrating them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-core-old-schema-'));
  const file = path.join(dir, 'core.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE legacy_marker (id INTEGER); PRAGMA user_version = 12');
  old.close();
  try {
    assert.throws(
      () => new CoreDatabase({ dataDir: dir }),
      (error) => error?.code === 'UNSUPPORTED_CORE_SCHEMA' && /version 12/.test(error.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
