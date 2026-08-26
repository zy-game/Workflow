import { transaction } from '../db/base.js';
import { INTERACTION_STATUSES, validateInteractionRequest, validateInteractionResponse } from '@workflow-core/shared';

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateAnswers(schema, answers) {
  const questions = Array.isArray(schema?.questions) ? schema.questions : [];
  if (!questions.length) return;
  const known = new Map(questions.map((question) => [question.id, question]));
  for (const answerId of Object.keys(answers || {})) {
    if (!known.has(answerId)) throw codedError('UNKNOWN_QUESTION', `unknown question id: ${answerId}`);
  }
  for (const question of questions) {
    if (question.required !== false && !Object.hasOwn(answers || {}, question.id)) {
      throw codedError('ANSWER_REQUIRED', `answer required for question: ${question.id}`);
    }
    if (!Object.hasOwn(answers || {}, question.id) || !Array.isArray(question.options)) continue;
    const optionIds = new Set(question.options.map((option) => option.id));
    const values = Array.isArray(answers[question.id]) ? answers[question.id] : [answers[question.id]];
    for (const value of values) {
      if (!optionIds.has(value)) throw codedError('UNKNOWN_OPTION', `unknown option id for ${question.id}: ${value}`);
    }
  }
}

export class InteractionRepository {
  constructor({ coreDb, db } = {}) {
    this.db = db || coreDb.db;
  }

  #map(row) {
    if (!row) return null;
    return {
      interaction_id: row.interaction_id,
      task_id: row.task_id,
      worker_id: row.worker_id,
      backend_kind: row.backend_kind,
      session_ref: row.session_ref,
      kind: row.kind,
      schema: JSON.parse(row.schema_json || '{}'),
      status: row.status,
      response_id: row.response_id,
      response: row.response_json ? JSON.parse(row.response_json) : null,
      answered_by: row.answered_by,
      created_at: row.created_at,
      expires_at: row.expires_at,
      answered_at: row.answered_at,
      delivered_at: row.delivered_at,
      consumed_at: row.consumed_at,
    };
  }

  create(request) {
    validateInteractionRequest(request);
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      const existing = this.get(request.interaction_id);
      if (existing) {
        const expected = {
          task_id: request.task_id,
          worker_id: request.worker_id ?? null,
          backend_kind: request.backend_kind ?? null,
          session_ref: request.session_ref ?? null,
          kind: request.kind,
          schema: request.schema ?? {},
          expires_at: request.expires_at ?? null,
        };
        const actual = {
          task_id: existing.task_id,
          worker_id: existing.worker_id,
          backend_kind: existing.backend_kind,
          session_ref: existing.session_ref,
          kind: existing.kind,
          schema: existing.schema,
          expires_at: existing.expires_at,
        };
        if (stableJson(expected) !== stableJson(actual)) {
          throw codedError('INTERACTION_CONFLICT', `interaction id already exists: ${request.interaction_id}`);
        }
        return existing;
      }
      this.db.prepare(`
        INSERT INTO interactions (
          interaction_id, task_id, worker_id, backend_kind, session_ref, kind,
          schema_json, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        request.interaction_id, request.task_id, request.worker_id ?? null,
        request.backend_kind ?? null, request.session_ref ?? null, request.kind,
        JSON.stringify(request.schema ?? {}), now, request.expires_at ?? null,
      );
      return this.get(request.interaction_id);
    });
  }

  get(id) {
    return this.#map(this.db.prepare('SELECT * FROM interactions WHERE interaction_id = ?').get(id));
  }

  list({ taskId = null, workerId = null, status = null } = {}) {
    if (status && !INTERACTION_STATUSES.includes(status)) throw new TypeError(`unknown interaction status: ${status}`);
    const clauses = [];
    const args = [];
    if (taskId) { clauses.push('task_id = ?'); args.push(taskId); }
    if (workerId) { clauses.push('worker_id = ?'); args.push(workerId); }
    if (status) { clauses.push('status = ?'); args.push(status); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM interactions${where} ORDER BY created_at, interaction_id`)
      .all(...args).map((row) => this.#map(row));
  }

  pendingDelivery(workerId) {
    return this.db.prepare(`
      SELECT * FROM interactions
      WHERE worker_id = ? AND status IN ('answered','delivered')
      ORDER BY answered_at, interaction_id
    `).all(workerId).map((row) => this.#map(row));
  }

  answer(id, response) {
    const value = validateInteractionResponse({ ...response, interaction_id: id });
    this.expire();
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM interactions WHERE interaction_id = ?').get(id);
      if (!row) return null;
      const existing = this.#map(row);
      if (['expired', 'cancelled'].includes(existing.status)) {
        throw codedError(`INTERACTION_${existing.status.toUpperCase()}`, `interaction is ${existing.status}`);
      }
      if (existing.response_id) {
        if (existing.response_id === value.response_id && stableJson(existing.response) === stableJson(value)) return existing;
        throw codedError('INTERACTION_RESPONSE_CONFLICT', 'interaction already has a different response');
      }
      const now = new Date().toISOString();
      if (existing.status !== 'pending') throw codedError('INTERACTION_NOT_PENDING', `interaction is ${existing.status}`);
      validateAnswers(existing.schema, value.answers ?? {});
      this.db.prepare(`
        UPDATE interactions SET status = 'answered', response_id = ?, response_json = ?,
          answered_by = ?, answered_at = ?
        WHERE interaction_id = ? AND status = 'pending'
      `).run(value.response_id, JSON.stringify(value), value.answered_by ?? null, now, id);
      return this.get(id);
    });
  }

  markDelivered(id) {
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return null;
      if (current.status === 'delivered' || current.status === 'consumed') return current;
      if (current.status !== 'answered') throw codedError('INTERACTION_NOT_ANSWERED', `interaction is ${current.status}`);
      this.db.prepare(`
        UPDATE interactions SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?)
        WHERE interaction_id = ? AND status = 'answered'
      `).run(now, id);
      return this.get(id);
    });
  }

  markConsumed(id, workerId) {
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return null;
      if (current.worker_id !== workerId) throw codedError('INTERACTION_OWNER_MISMATCH', 'interaction belongs to another worker');
      if (current.status === 'consumed') return current;
      if (current.status !== 'delivered') throw codedError('INTERACTION_NOT_DELIVERED', `interaction is ${current.status}`);
      this.db.prepare(`
        UPDATE interactions SET status = 'consumed', consumed_at = ?
        WHERE interaction_id = ? AND status = 'delivered'
      `).run(now, id);
      return this.get(id);
    });
  }

  cancel(id) {
    this.db.prepare(`
      UPDATE interactions SET status = 'cancelled'
      WHERE interaction_id = ? AND status IN ('pending','answered','delivered')
    `).run(id);
    return this.get(id);
  }

  expire(now = new Date().toISOString()) {
    return this.db.prepare(`
      UPDATE interactions SET status = 'expired'
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now).changes;
  }
}
