import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 3;
const DEFAULT_MAX_OUTBOX_FRAMES = 2_000;
const DEFAULT_MAX_OUTBOX_BYTES = 16 * 1024 * 1024;

function json(value, fallback = null) {
  return value === null || value === undefined ? fallback : JSON.stringify(value);
}

function runFromRow(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    claimToken: row.claim_token,
    projectId: row.project_id,
    backendKind: row.backend_kind,
    sessionRef: row.session_ref,
    phase: row.phase,
    lastEventSeq: Number(row.last_event_seq),
    lastAssistant: row.last_assistant,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    terminalFrameId: row.terminal_frame_id,
    interactionId: row.interaction_id,
    updatedAt: row.updated_at,
  };
}

function outboxFromRow(row) {
  if (!row) return null;
  return {
    sequence: Number(row.sequence),
    frameId: row.frame_id,
    type: row.type,
    payload: JSON.parse(row.payload_json),
    bytes: Number(row.bytes),
    createdAt: row.created_at,
  };
}

export class RunStore {
  constructor({ dataDir, filename = null, maxOutboxFrames = DEFAULT_MAX_OUTBOX_FRAMES,
    maxOutboxBytes = DEFAULT_MAX_OUTBOX_BYTES } = {}) {
    if (!dataDir && !filename) throw new TypeError('dataDir or filename is required');
    this.file = path.resolve(filename || path.join(dataDir, 'worker.db'));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.maxOutboxFrames = maxOutboxFrames;
    this.maxOutboxBytes = maxOutboxBytes;
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const current = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (current !== 0 && current !== SCHEMA_VERSION) {
      this.db.close();
      this.db = null;
      const error = new Error(`unsupported worker.db schema version ${current}; expected ${SCHEMA_VERSION}`);
      error.code = 'UNSUPPORTED_WORKER_SCHEMA';
      throw error;
    }
    if (current === 0) {
      this.db.exec(`
        CREATE TABLE runs (
          task_id TEXT PRIMARY KEY,
          claim_token TEXT NOT NULL,
          project_id TEXT,
          backend_kind TEXT NOT NULL,
          session_ref TEXT,
          phase TEXT NOT NULL CHECK (phase IN ('dispatched','running','awaiting_input','completion_pending')),
          last_event_seq INTEGER NOT NULL DEFAULT -1,
          last_assistant TEXT,
          result_json TEXT,
          terminal_frame_id TEXT,
          interaction_id TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE outbound_frames (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          frame_id TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX outbound_frames_order ON outbound_frames(sequence);
        PRAGMA user_version = 3;
      `);
    }
  }

  get(taskId) {
    return runFromRow(this.db.prepare('SELECT * FROM runs WHERE task_id = ?').get(taskId));
  }

  list() {
    return this.db.prepare('SELECT * FROM runs ORDER BY updated_at, task_id').all().map(runFromRow);
  }

  put({ taskId, claimToken, projectId = null, backendKind, sessionRef = null,
    phase = 'dispatched', lastEventSeq = -1, lastAssistant = null, result = null,
    terminalFrameId = null, interactionId = null }) {
    if (!taskId || !claimToken || !backendKind) throw new TypeError('taskId, claimToken and backendKind are required');
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO runs (
        task_id, claim_token, project_id, backend_kind, session_ref, phase,
        last_event_seq, last_assistant, result_json, terminal_frame_id, interaction_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        claim_token = excluded.claim_token,
        project_id = excluded.project_id,
        backend_kind = excluded.backend_kind,
        session_ref = excluded.session_ref,
        phase = excluded.phase,
        last_event_seq = excluded.last_event_seq,
        last_assistant = excluded.last_assistant,
        result_json = excluded.result_json,
        terminal_frame_id = excluded.terminal_frame_id,
        interaction_id = excluded.interaction_id,
        updated_at = excluded.updated_at
    `).run(taskId, claimToken, projectId, backendKind, sessionRef, phase,
      lastEventSeq, lastAssistant, json(result), terminalFrameId, interactionId, now);
    return this.get(taskId);
  }

  update(taskId, changes = {}) {
    const current = this.get(taskId);
    if (!current) return null;
    return this.put({ ...current, ...changes, taskId });
  }

  delete(taskId) {
    return this.db.prepare('DELETE FROM runs WHERE task_id = ?').run(taskId).changes > 0;
  }

  enqueue({ frameId, type, payload }) {
    if (!frameId || !type || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('frameId, type and payload are required');
    }
    const existing = this.db.prepare('SELECT * FROM outbound_frames WHERE frame_id = ?').get(frameId);
    if (existing) return outboxFromRow(existing);
    const payloadJson = JSON.stringify(payload);
    const bytes = Buffer.byteLength(payloadJson, 'utf8');
    const counts = this.db.prepare('SELECT COUNT(*) AS frames, COALESCE(SUM(bytes), 0) AS bytes FROM outbound_frames').get();
    if (Number(counts.frames) >= this.maxOutboxFrames || Number(counts.bytes) + bytes > this.maxOutboxBytes) {
      const error = new Error('worker outbound outbox is full');
      error.code = 'WORKER_OUTBOX_FULL';
      throw error;
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO outbound_frames (frame_id, type, payload_json, bytes, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(frameId, type, payloadJson, bytes, now);
    return outboxFromRow(this.db.prepare('SELECT * FROM outbound_frames WHERE frame_id = ?').get(frameId));
  }

  pendingFrames(limit = 100) {
    const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare('SELECT * FROM outbound_frames ORDER BY sequence LIMIT ?').all(bounded).map(outboxFromRow);
  }

  removeFrame(frameId) {
    return this.db.prepare('DELETE FROM outbound_frames WHERE frame_id = ?').run(frameId).changes > 0;
  }

  hasFrame(frameId) {
    return Boolean(this.db.prepare('SELECT 1 AS found FROM outbound_frames WHERE frame_id = ?').get(frameId));
  }

  outboxSize() {
    const row = this.db.prepare('SELECT COUNT(*) AS frames, COALESCE(SUM(bytes), 0) AS bytes FROM outbound_frames').get();
    return { frames: Number(row.frames), bytes: Number(row.bytes) };
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}

export { SCHEMA_VERSION as WORKER_DB_SCHEMA_VERSION };
