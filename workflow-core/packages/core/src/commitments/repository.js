// commitments/repository.js - the responsibilities the assistant holds for the
// user. State is always derived from the appended event log, never overwritten
// silently: the current row is a projection of commitment_events.
import crypto from 'node:crypto';

export const COMMITMENT_STATES = ['active', 'needs_decision', 'fulfilled', 'dropped', 'expired'];

// Event type -> resulting state. Anything not listed keeps the current state.
const STATE_BY_EVENT = Object.freeze({
  created: 'active',
  reactivated: 'active',
  needs_decision: 'needs_decision',
  fulfilled: 'fulfilled',
  dropped: 'dropped',
  expired: 'expired',
});

function commitmentFromRow(row) {
  return {
    commitmentId: row.commitment_id,
    ownerId: row.owner_id ?? null,
    projectId: row.project_id ?? null,
    channelRef: row.channel_ref ?? null,
    statement: row.statement,
    state: row.state,
    triggerPolicy: row.trigger_policy,
    attentionPolicy: row.attention_policy,
    dueAt: row.due_at ?? null,
    lastEvaluatedAt: row.last_evaluated_at ?? null,
    lastActivityAt: row.last_activity_at ?? null,
    lastAttentionAt: row.last_attention_at ?? null,
    sourceSignalIds: JSON.parse(row.source_signal_ids_json || '[]'),
    evidenceRefs: JSON.parse(row.evidence_refs_json || '[]'),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row) {
  return {
    eventId: row.event_id,
    commitmentId: row.commitment_id,
    type: row.type,
    payload: JSON.parse(row.payload_json || '{}'),
    actor: row.actor ?? null,
    createdAt: row.created_at,
  };
}

export class CommitmentRepository {
  constructor({ coreDb }) {
    this.db = coreDb?.db ?? null;
  }

  #requireDb() {
    if (!this.db) throw new Error('commitment repository requires coreDb');
  }

  create({
    commitmentId = `cmt-${crypto.randomUUID()}`,
    ownerId = null,
    projectId = null,
    channelRef = null,
    statement,
    triggerPolicy = 'on_signal',
    attentionPolicy = 'immediate',
    dueAt = null,
    sourceSignalIds = [],
    evidenceRefs = [],
    actor = null,
  } = {}) {
    this.#requireDb();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO commitments (
        commitment_id, owner_id, project_id, channel_ref, statement, state,
        trigger_policy, attention_policy, due_at, source_signal_ids_json,
        evidence_refs_json, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      commitmentId, ownerId, projectId, channelRef, String(statement),
      String(triggerPolicy), String(attentionPolicy), dueAt,
      JSON.stringify(sourceSignalIds ?? []), JSON.stringify(evidenceRefs ?? []),
      now, now,
    );
    this.applyEvent({ commitmentId, type: 'created', actor, payload: { statement: String(statement) } });
    return this.get(commitmentId);
  }

  get(commitmentId) {
    const row = this.db?.prepare('SELECT * FROM commitments WHERE commitment_id = ?').get(commitmentId);
    return row ? commitmentFromRow(row) : null;
  }

  list({ state = null, projectId = null, limit = 200 } = {}) {
    this.#requireDb();
    const bounded = Math.min(1000, Math.max(1, Number(limit) || 200));
    const clauses = [];
    const args = [];
    if (state) { clauses.push('state = ?'); args.push(state); }
    if (projectId) { clauses.push('project_id = ?'); args.push(projectId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    args.push(bounded);
    return this.db.prepare(`SELECT * FROM commitments ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...args).map(commitmentFromRow);
  }

  // Append-only: the event is the record, the row is the projection.
  applyEvent({ commitmentId, type, payload = {}, actor = null }) {
    this.#requireDb();
    const existing = this.get(commitmentId);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO commitment_events (event_id, commitment_id, type, payload_json, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`cev-${crypto.randomUUID()}`, commitmentId, String(type), JSON.stringify(payload ?? {}), actor, now);
    const nextState = STATE_BY_EVENT[type] ?? existing.state;
    this.db.prepare(`
      UPDATE commitments SET state = ?, version = version + 1, updated_at = ? WHERE commitment_id = ?
    `).run(nextState, now, commitmentId);
    return this.get(commitmentId);
  }

  // Evaluation bookkeeping. These are observations, not state transitions, so
  // they do not bump the version.
  touch(commitmentId, { lastEvaluatedAt = null, lastActivityAt = null, lastAttentionAt = null } = {}) {
    this.#requireDb();
    const fields = [];
    const args = [];
    for (const [column, value] of [
      ['last_evaluated_at', lastEvaluatedAt],
      ['last_activity_at', lastActivityAt],
      ['last_attention_at', lastAttentionAt],
    ]) {
      if (value === null) continue;
      fields.push(`${column} = ?`);
      args.push(value);
    }
    if (!fields.length) return this.get(commitmentId);
    args.push(commitmentId);
    this.db.prepare(`UPDATE commitments SET ${fields.join(', ')} WHERE commitment_id = ?`).run(...args);
    return this.get(commitmentId);
  }

  events(commitmentId) {
    this.#requireDb();
    return this.db.prepare('SELECT * FROM commitment_events WHERE commitment_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(String(commitmentId)).map(eventFromRow);
  }
}
