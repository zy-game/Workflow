import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;

function fromRow(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    claimToken: row.claim_token,
    sessionId: row.session_id,
    lastSeq: Number(row.last_seq),
    lastAssistant: row.last_assistant,
    phase: row.phase,
    updatedAt: row.updated_at,
  };
}

export class WorkerStateStore {
  constructor({ dataDir, filename = null } = {}) {
    if (!dataDir && !filename) throw new TypeError('dataDir or filename is required');
    this.file = path.resolve(filename || path.join(dataDir, 'worker.db'));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS worker_sessions (
        task_id TEXT PRIMARY KEY,
        claim_token TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT -1,
        last_assistant TEXT,
        phase TEXT NOT NULL CHECK (phase IN ('created','prompting','running','completion_pending')),
        updated_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  get(taskId) {
    return fromRow(this.db.prepare('SELECT * FROM worker_sessions WHERE task_id = ?').get(taskId));
  }

  put({ taskId, claimToken, sessionId, lastSeq = -1, lastAssistant = null, phase = 'created' }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO worker_sessions (
        task_id, claim_token, session_id, last_seq, last_assistant, phase, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        claim_token = excluded.claim_token,
        session_id = excluded.session_id,
        last_seq = excluded.last_seq,
        last_assistant = excluded.last_assistant,
        phase = excluded.phase,
        updated_at = excluded.updated_at
    `).run(taskId, claimToken, sessionId, lastSeq, lastAssistant, phase, now);
    return this.get(taskId);
  }

  update(taskId, changes = {}) {
    const current = this.get(taskId);
    if (!current) return null;
    return this.put({ ...current, ...changes, taskId });
  }

  delete(taskId) {
    return this.db.prepare('DELETE FROM worker_sessions WHERE task_id = ?').run(taskId).changes > 0;
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}
