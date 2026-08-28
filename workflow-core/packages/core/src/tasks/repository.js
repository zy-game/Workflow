// repository.js - task authority over core.db: priority queue, dependency
// gate, lease-based claiming with dead-letter, and the append-only task event
// log (including live worker session events). Schema lives in db/core-db.js.
import crypto from 'node:crypto';
import { DEFAULT_PRIORITY, PRIORITY_MIN, PRIORITY_MAX, TASK_RESULT_KINDS } from '@workflow-core/shared';
import { transaction } from '../db/base.js';
import { CoreDatabase } from '../db/core-db.js';

export const DEFAULT_CLAIM_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 3;

const ACTIVE_STATUSES = Object.freeze(['dispatched', 'running', 'awaiting_input']);

function taskFromRow(row) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    type: row.type,
    title: row.title,
    brief: JSON.parse(row.brief_json),
    priority: Number(row.priority),
    status: row.status,
    created_by: row.created_by,
    project_id: row.project_id,
    agent_id: row.agent_id,
    backend_kind: row.backend_kind,
    requested_backend_kind: row.requested_backend_kind,
    required_capabilities: JSON.parse(row.required_capabilities_json || '[]'),
    execution_policy: JSON.parse(row.execution_policy_json || '{}'),
    session_ref: row.session_ref,
    worker_selector: JSON.parse(row.worker_selector_json || '{}'),
    dependencies: JSON.parse(row.dependencies_json || '[]'),
    idempotency_key: row.idempotency_key,
    claim_token: row.claim_token,
    claim_worker_id: row.claim_worker_id,
    lease_deadline: row.lease_deadline,
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    result_kind: row.result_kind,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function eventFromRow(row) {
  if (!row) return null;
  return {
    event_id: row.event_id, task_id: row.task_id, seq: Number(row.seq), ts: row.ts,
    type: row.type, actor: row.actor, payload: JSON.parse(row.payload_json || '{}'),
  };
}

export class TaskRepository {
  // Accepts either a shared CoreDatabase ({ coreDb }) or its own data
  // directory; every repository over one core.db must share one handle.
  constructor({ coreDb, dataDir, dbFile, busyTimeoutMs, claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS } = {}) {
    if (coreDb) {
      this.db = coreDb.db;
      this.ownsDb = false;
    } else {
      this.coreDatabase = new CoreDatabase({ dataDir, dbFile, busyTimeoutMs });
      this.db = this.coreDatabase.db;
      this.ownsDb = true;
    }
    this.claimTimeoutMs = claimTimeoutMs;
    this.eventListeners = [];
  }

  close() {
    if (!this.ownsDb) { this.db = null; return; }
    this.coreDatabase.close();
    this.db = null;
  }

  #appendEvent(taskId, type, payload = {}, actor = null) {
    const next = Number(this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM task_events WHERE task_id = ?').get(taskId).next);
    this.db.prepare(`
      INSERT INTO task_events (event_id, task_id, seq, ts, type, actor, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`te-${crypto.randomUUID()}`, taskId, next, new Date().toISOString(), type, actor, JSON.stringify(payload));
    // Observers (Feishu watch cards, future SSE) must never break writes.
    for (const listener of this.eventListeners) {
      try { listener({ task_id: taskId, type, payload, actor, seq: next }); } catch { /* observer error is contained */ }
    }
    return next;
  }

  // Registers a task-event observer. Listeners run synchronously inside the
  // writing transaction - keep them cheap (schedule async work outward).
  onEvent(listener) {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((entry) => entry !== listener);
    };
  }

  create(input) {
    const {
      type, title = null, brief, priority = DEFAULT_PRIORITY, created_by,
      project_id = null, worker_selector = {}, dependencies = [], idempotency_key = null,
      max_attempts = DEFAULT_MAX_ATTEMPTS,
      agent_id = null, session_ref = null,
      backend_kind = null, required_capabilities = [], execution_policy = {},
    } = input;
    const selector = worker_selector || {};
    if (Object.hasOwn(input, 'workspace') || Object.hasOwn(brief ?? {}, 'workspace')) {
      throw new TypeError('workspace paths are Worker-local and cannot be stored in Core tasks');
    }
    if (!type || typeof type !== 'string') throw new TypeError('type is required');
    if (!brief || typeof brief !== 'object' || Array.isArray(brief)) throw new TypeError('brief must be an object');
    if (!created_by || typeof created_by !== 'string') throw new TypeError('created_by is required');
    const priorityValue = Number(priority);
    if (!Number.isInteger(priorityValue) || priorityValue < PRIORITY_MIN || priorityValue > PRIORITY_MAX) {
      throw new TypeError(`priority must be an integer ${PRIORITY_MIN}-${PRIORITY_MAX}`);
    }
    if (!Array.isArray(dependencies) || dependencies.some((id) => typeof id !== 'string' || !id)) {
      throw new TypeError('dependencies must be an array of task ids');
    }
    const attemptsLimit = Number(max_attempts);
    if (!Number.isInteger(attemptsLimit) || attemptsLimit < 1 || attemptsLimit > 10) {
      throw new TypeError('max_attempts must be an integer 1-10');
    }
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      if (idempotency_key) {
        const existing = this.db.prepare(
          'SELECT * FROM tasks WHERE created_by = ? AND idempotency_key = ?',
        ).get(created_by, idempotency_key);
        if (existing) return { task: taskFromRow(existing), idempotent_replay: true };
      }
      // Dependencies may only reference already-existing tasks, which makes
      // dependency cycles structurally impossible (deps are fixed at creation).
      for (const dep of dependencies) {
        const row = this.db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(dep);
        if (!row) {
          const error = new Error(`dependency does not exist: ${dep}`);
          error.code = 'UNKNOWN_DEPENDENCY';
          throw error;
        }
      }
      const taskId = `t-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO tasks (
          task_id, type, title, brief_json, priority, status, created_by, project_id,
          worker_selector_json, dependencies_json, idempotency_key, attempts, max_attempts,
          agent_id, session_ref, backend_kind, requested_backend_kind,
          required_capabilities_json, execution_policy_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId, type, title, JSON.stringify(brief), priorityValue, created_by, project_id,
        JSON.stringify(selector), JSON.stringify([...new Set(dependencies)]),
        idempotency_key, attemptsLimit, agent_id, session_ref,
        backend_kind, backend_kind, JSON.stringify([...new Set(required_capabilities)]),
        JSON.stringify(execution_policy), now, now,
      );
      this.#appendEvent(taskId, 'created', { type, priority, dependencies }, created_by);
      return { task: this.get(taskId), idempotent_replay: false };
    });
  }

  get(taskId) {
    return taskFromRow(this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId));
  }

  list({ status = null, priority = null, project_id = null, limit = 100 } = {}) {
    const clauses = [];
    const args = [];
    if (status) { clauses.push('status = ?'); args.push(status); }
    if (Number.isInteger(priority)) { clauses.push('priority = ?'); args.push(priority); }
    if (project_id) { clauses.push('project_id = ?'); args.push(project_id); }
    const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM tasks${where} ORDER BY priority ASC, created_at ASC LIMIT ?`,
    ).all(...args, bounded).map(taskFromRow);
  }

  activeForWorker(workerId, now = new Date().toISOString()) {
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE claim_worker_id = ? AND status IN ('dispatched','running','awaiting_input')
        AND lease_deadline IS NOT NULL AND lease_deadline > ?
      ORDER BY started_at ASC, created_at ASC
    `).all(workerId, now).map(taskFromRow);
  }

  #dependenciesMet(taskId) {
    const dependencies = JSON.parse(this.db.prepare('SELECT dependencies_json FROM tasks WHERE task_id = ?').get(taskId).dependencies_json || '[]');
    if (!dependencies.length) return true;
    const rows = this.db.prepare(
      `SELECT task_id, status FROM tasks WHERE task_id IN (${dependencies.map(() => '?').join(',')})`,
    ).all(...dependencies);
    const byId = new Map(rows.map((row) => [row.task_id, row.status]));
    return dependencies.every((dep) => byId.get(dep) === 'done');
  }

  // Reclaims expired leases (dead-lettering tasks past max_attempts), then
  // hands the oldest priority-ordered queued task whose dependencies are done
  // to the claiming worker under a fresh lease.
  claim({
    worker_id, selector = null, project_ids = null, project_id = undefined,
    capabilities = [], backends = [],
  } = {}) {
    if (!worker_id || typeof worker_id !== 'string') throw new TypeError('worker_id is required');
    const availableCapabilities = new Set(Array.isArray(capabilities) ? capabilities.map(String) : []);
    const backendDescriptors = Array.isArray(backends) ? backends : [];
    const backendByKind = new Map(backendDescriptors.map((backend) => [backend.kind, backend]));
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      const expired = this.db.prepare(
        `SELECT task_id, attempts, max_attempts FROM tasks
         WHERE status IN ('dispatched','running','awaiting_input') AND lease_deadline IS NOT NULL AND lease_deadline <= ?`,
      ).all(now);
      for (const row of expired) {
        if (row.attempts >= row.max_attempts) {
          this.db.prepare(
            `UPDATE tasks SET status = 'failed', result_kind = 'failed', result_json = ?,
             claim_token = NULL, lease_deadline = NULL, updated_at = ?, finished_at = ?
             WHERE task_id = ?`,
          ).run(JSON.stringify({ reason: 'lease_expired_dead_letter' }), now, now, row.task_id);
          this.#appendEvent(row.task_id, 'dead_letter', { attempts: row.attempts }, 'scheduler');
        } else {
          // Requeued without bumping attempts: the subsequent claim performs
          // the increment, keeping one attempt per actual dispatch.
          this.db.prepare(
            `UPDATE tasks SET status = 'queued', claim_token = NULL, claim_worker_id = NULL,
             backend_kind = requested_backend_kind,
             lease_deadline = NULL, updated_at = ? WHERE task_id = ?`,
          ).run(now, row.task_id);
          this.#appendEvent(row.task_id, 'lease_expired_requeued', { attempts: row.attempts }, 'scheduler');
        }
      }

      const candidates = this.db.prepare(
        `SELECT task_id FROM tasks WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT 200`,
      ).all();
      for (const candidate of candidates) {
        const task = this.get(candidate.task_id);
        if (!this.#dependenciesMet(task.task_id)) continue;
        if (selector && !selectorMatches(task.worker_selector, selector)) continue;
        if (Array.isArray(project_ids)) {
          const allowed = project_ids.map(String);
          if (task.project_id && !allowed.includes('*') && !allowed.includes(task.project_id)) continue;
        }
        if (project_id !== undefined && task.project_id !== project_id) continue;
        const required = new Set(task.required_capabilities);
        const eligibleBackends = task.requested_backend_kind
          ? [backendByKind.get(task.requested_backend_kind)].filter(Boolean)
          : backendDescriptors;
        const selectedBackend = eligibleBackends.find((backend) => {
          if (backend.healthy === false || backend.enabled === false) return false;
          const combined = new Set([...availableCapabilities, ...(backend.capabilities || []).map(String)]);
          return [...required].every((capability) => combined.has(capability));
        });
        if (!selectedBackend) continue;
        const claimToken = crypto.randomBytes(24).toString('base64url');
        const deadline = new Date(Date.now() + this.claimTimeoutMs).toISOString();
        const changes = this.db.prepare(`
          UPDATE tasks SET status = 'dispatched', claim_token = ?, claim_worker_id = ?,
          backend_kind = ?, lease_deadline = ?, attempts = attempts + 1, updated_at = ?,
          started_at = COALESCE(started_at, ?) WHERE task_id = ? AND status = 'queued'
        `).run(claimToken, worker_id, selectedBackend.kind, deadline, now, now, task.task_id).changes;
        if (!changes) continue; // raced with another claim; try the next candidate
        this.#appendEvent(task.task_id, 'claimed', {
          worker_id,
          backend_kind: selectedBackend.kind,
          attempt: task.attempts + 1,
          claim_token_hash: crypto.createHash('sha256').update(claimToken).digest('hex'),
        }, worker_id);
        return this.get(task.task_id);
      }
      return null;
    });
  }

  releaseUndeliveredClaim(taskId, claimToken, actor = 'scheduler') {
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      const row = this.#requireLiveClaim(taskId, claimToken);
      if (row.status !== 'dispatched') {
        const error = new Error(`task dispatch already started (status ${row.status})`);
        error.code = 'TASK_ALREADY_STARTED';
        throw error;
      }
      this.db.prepare(`
        UPDATE tasks SET status = 'queued', claim_token = NULL, claim_worker_id = NULL,
        backend_kind = requested_backend_kind,
        lease_deadline = NULL, attempts = MAX(attempts - 1, 0),
        updated_at = ?, started_at = CASE WHEN attempts <= 1 THEN NULL ELSE started_at END
        WHERE task_id = ? AND claim_token = ?
      `).run(now, taskId, claimToken);
      this.#appendEvent(taskId, 'dispatch_undelivered', { worker_id: row.claim_worker_id }, actor);
      return this.get(taskId);
    });
  }

  #requireLiveClaim(taskId, claimToken) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!row) {
      const error = new Error('task does not exist');
      error.code = 'TASK_NOT_FOUND';
      throw error;
    }
    if (!ACTIVE_STATUSES.includes(row.status)) {
      const error = new Error(`task is not active (status ${row.status})`);
      error.code = 'TASK_NOT_ACTIVE';
      throw error;
    }
    if (!claimToken || claimToken !== row.claim_token) {
      const error = new Error('claim token mismatch');
      error.code = 'CLAIM_MISMATCH';
      throw error;
    }
    if (row.lease_deadline && row.lease_deadline <= new Date().toISOString()) {
      const error = new Error('lease expired');
      error.code = 'LEASE_EXPIRED';
      throw error;
    }
    return row;
  }

  renew(taskId, claimToken) {
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      this.#requireLiveClaim(taskId, claimToken);
      const deadline = new Date(Date.now() + this.claimTimeoutMs).toISOString();
      this.db.prepare('UPDATE tasks SET lease_deadline = ?, updated_at = ? WHERE task_id = ?')
        .run(deadline, now, taskId);
      this.#appendEvent(taskId, 'renewed', { lease_deadline: deadline });
      return this.get(taskId);
    });
  }

  progress(taskId, claimToken, { note = null, percent = null, events = [] } = {}) {
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      this.#requireLiveClaim(taskId, claimToken);
      const deadline = new Date(Date.now() + this.claimTimeoutMs).toISOString();
      this.db.prepare(
        `UPDATE tasks SET status = 'running', lease_deadline = ?, updated_at = ? WHERE task_id = ?`,
      ).run(deadline, now, taskId);
      this.#appendEvent(taskId, 'progress', { note, percent });
      for (const event of Array.isArray(events) ? events : []) {
        this.#appendEvent(taskId, 'session_event', event);
      }
      return this.get(taskId);
    });
  }

  appendSessionEvent(taskId, event, actor = null) {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(taskId);
      if (!row) {
        const error = new Error('task does not exist');
        error.code = 'TASK_NOT_FOUND';
        throw error;
      }
      if (event && typeof event.session_ref === 'string' && event.session_ref) {
        this.db.prepare('UPDATE tasks SET session_ref = ?, updated_at = ? WHERE task_id = ?')
          .run(event.session_ref, new Date().toISOString(), taskId);
      }
      const seq = this.#appendEvent(taskId, 'session_event', event, actor);
      return { seq };
    });
  }

  appendEvent(taskId, type, payload = {}, actor = null) {
    if (typeof type !== 'string' || !type) throw new TypeError('event type is required');
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(taskId);
      if (!row) {
        const error = new Error('task does not exist');
        error.code = 'TASK_NOT_FOUND';
        throw error;
      }
      const seq = this.#appendEvent(taskId, type, payload, actor);
      return { seq };
    });
  }

  enterAwaitingInput(taskId, claimToken, interactionId) {
    if (!interactionId || typeof interactionId !== 'string') throw new TypeError('interaction_id is required');
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      this.#requireLiveClaim(taskId, claimToken);
      const deadline = new Date(Date.now() + this.claimTimeoutMs).toISOString();
      this.db.prepare(`
        UPDATE tasks SET status = 'awaiting_input', lease_deadline = ?, updated_at = ?
        WHERE task_id = ?
      `).run(deadline, now, taskId);
      this.#appendEvent(taskId, 'awaiting_input', { interaction_id: interactionId }, 'worker');
      return this.get(taskId);
    });
  }

  resumeAfterInput(taskId, claimToken, interactionId, actor = 'core') {
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      const row = this.#requireLiveClaim(taskId, claimToken);
      if (row.status !== 'awaiting_input') {
        const error = new Error(`task is not awaiting input (status ${row.status})`);
        error.code = 'TASK_NOT_AWAITING_INPUT';
        throw error;
      }
      const deadline = new Date(Date.now() + this.claimTimeoutMs).toISOString();
      this.db.prepare(`
        UPDATE tasks SET status = 'running', lease_deadline = ?, updated_at = ?
        WHERE task_id = ?
      `).run(deadline, now, taskId);
      this.#appendEvent(taskId, 'input_delivered', { interaction_id: interactionId }, actor);
      return this.get(taskId);
    });
  }

  done(taskId, claimToken, { kind = 'done', result = null, session_ref = null } = {}) {
    if (!TASK_RESULT_KINDS.includes(kind)) throw new TypeError(`unknown result kind: ${kind}`);
    if (kind === 'question') throw new TypeError('question results must use enterAwaitingInput()');
    const status = kind === 'failed' ? 'failed'
      : kind === 'blocked' ? 'blocked' : 'done';
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      this.#requireLiveClaim(taskId, claimToken);
      this.db.prepare(`
        UPDATE tasks SET status = ?, result_kind = ?, result_json = ?,
        session_ref = COALESCE(?, session_ref),
        claim_token = NULL, claim_worker_id = NULL, lease_deadline = NULL,
        updated_at = ?, finished_at = ? WHERE task_id = ?
      `).run(status, kind, JSON.stringify(result ?? {}), session_ref, now, now, taskId);
      this.#appendEvent(taskId, 'done', { kind }, 'worker');
      return this.get(taskId);
    });
  }

  cancel(taskId, actor) {
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
      if (!row) {
        const error = new Error('task does not exist');
        error.code = 'TASK_NOT_FOUND';
        throw error;
      }
      if (['done', 'failed', 'cancelled'].includes(row.status)) {
        const error = new Error(`task already ${row.status}`);
        error.code = 'TASK_NOT_CANCELLABLE';
        throw error;
      }
      this.db.prepare(`
        UPDATE tasks SET status = 'cancelled', claim_token = NULL, claim_worker_id = NULL,
        lease_deadline = NULL, updated_at = ?, finished_at = ? WHERE task_id = ?
      `).run(now, now, taskId);
      this.#appendEvent(taskId, 'cancelled', {}, actor);
      return this.get(taskId);
    });
  }

  // afterSeq pages by "strictly greater than the last seen seq"; -1 (before
  // the first event) is the natural start cursor.
  events(taskId, { afterSeq = -1, limit = 500, type = null } = {}) {
    const bounded = Math.min(2000, Math.max(1, Number(limit) || 500));
    const rows = type
      ? this.db.prepare(
        'SELECT * FROM task_events WHERE task_id = ? AND seq > ? AND type = ? ORDER BY seq ASC LIMIT ?',
      ).all(taskId, afterSeq, type, bounded)
      : this.db.prepare(
        'SELECT * FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      ).all(taskId, afterSeq, bounded);
    return rows.map(eventFromRow);
  }

  countsByStatus() {
    const rows = this.db.prepare('SELECT status, count(*) AS count FROM tasks GROUP BY status').all();
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  integrityCheck() {
    const integrity = this.db.prepare('PRAGMA integrity_check').get();
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all();
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    return {
      ok: integrity.integrity_check === 'ok' && foreignKeys.length === 0,
      version,
    };
  }
}

// A task's worker_selector constrains who may claim it. An empty selector is
// open to all; otherwise every provided field must match the worker's selector.
export function selectorMatches(taskSelector, workerSelector) {
  if (!taskSelector || typeof taskSelector !== 'object') return true;
  for (const [key, value] of Object.entries(taskSelector)) {
    if (value === null || value === undefined || value === '') continue;
    const workerValue = workerSelector?.[key];
    if (Array.isArray(value)) {
      if (!Array.isArray(workerValue) || !value.some((entry) => workerValue.includes(entry))) return false;
    } else if (workerValue !== value) return false;
  }
  return true;
}
