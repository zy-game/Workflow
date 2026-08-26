import assert from 'node:assert/strict';
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
    assert.equal(CORE_DB_SCHEMA_VERSION, 13);
    assert.deepEqual(core.integrityCheck(), { ok: true, version: 13 });

    const tables = new Set(core.db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => row.name));
    for (const required of ['tasks', 'workers', 'interactions', 'task_events']) {
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
  } finally {
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Core rejects pre-v13 databases instead of partially migrating them', () => {
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
