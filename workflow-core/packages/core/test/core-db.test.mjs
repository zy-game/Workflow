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
    assert.equal(CORE_DB_SCHEMA_VERSION, 14);
    assert.deepEqual(core.integrityCheck(), { ok: true, version: 14 });

    const tables = new Set(core.db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => row.name));
    for (const required of ['tasks', 'workers', 'interactions', 'task_events', 'bridge_requests', 'server_settings']) {
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
    PRAGMA user_version = 14;
  `);
  old.close();
  const core = new CoreDatabase({ dataDir: dir });
  try {
    assert.deepEqual(core.integrityCheck(), { ok: true, version: 14 });
    assert.ok(core.db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'server_settings'",
    ).get());
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
    assert.deepEqual(core.integrityCheck(), { ok: true, version: 14 });
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
