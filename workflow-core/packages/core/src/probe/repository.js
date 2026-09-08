// probe/repository.js - read-only status inquiries queued for the executor
// node that owns a project. A probe is deliberately not a task: it never
// claims a lease, never consumes an attempt, and it may answer "unknown".
import crypto from 'node:crypto';

export const PROBE_STATES = ['queued', 'claimed', 'answered', 'expired'];
export const PROBE_VERDICTS = ['done', 'not_done', 'unknown'];

function probeFromRow(row) {
  return {
    probeId: row.probe_id,
    projectId: row.project_id,
    question: row.question,
    refs: JSON.parse(row.refs_json || '[]'),
    budgetMs: Number(row.budget_ms),
    state: row.state,
    verdict: row.verdict ?? null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    evidence: JSON.parse(row.evidence_json || '[]'),
    suggestedReply: row.suggested_reply ?? null,
    requestedBy: row.requested_by ?? null,
    requestedAt: row.requested_at,
    deadlineAt: row.deadline_at,
    claimedBy: row.claimed_by ?? null,
    claimedAt: row.claimed_at ?? null,
    answeredAt: row.answered_at ?? null,
  };
}

export class ProbeRepository {
  constructor({ coreDb }) {
    this.db = coreDb?.db ?? null;
  }

  #requireDb() {
    if (!this.db) throw new Error('probe repository requires coreDb');
  }

  create({
    probeId = `probe-${crypto.randomUUID()}`,
    projectId,
    question,
    refs = [],
    budgetMs = 60_000,
    requestedBy = null,
  } = {}) {
    this.#requireDb();
    const requestedAt = new Date();
    const deadlineAt = new Date(requestedAt.getTime() + budgetMs);
    this.db.prepare(`
      INSERT INTO probes (
        probe_id, project_id, question, refs_json, budget_ms, state,
        requested_by, requested_at, deadline_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      probeId, String(projectId), String(question), JSON.stringify(refs ?? []),
      Number(budgetMs), requestedBy, requestedAt.toISOString(), deadlineAt.toISOString(),
    );
    return this.get(probeId);
  }

  get(probeId) {
    const row = this.db?.prepare('SELECT * FROM probes WHERE probe_id = ?').get(probeId);
    return row ? probeFromRow(row) : null;
  }

  list({ state = null, limit = 100 } = {}) {
    this.#requireDb();
    const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = state
      ? this.db.prepare('SELECT * FROM probes WHERE state = ? ORDER BY requested_at DESC LIMIT ?').all(state, bounded)
      : this.db.prepare('SELECT * FROM probes ORDER BY requested_at DESC LIMIT ?').all(bounded);
    return rows.map(probeFromRow);
  }

  // An unanswered probe past its deadline is "expired", never a guess: the
  // caller treats expiry exactly like an "unknown" verdict.
  expireOverdue(now = new Date().toISOString()) {
    this.#requireDb();
    return this.db.prepare(
      "UPDATE probes SET state = 'expired' WHERE state IN ('queued','claimed') AND deadline_at <= ?",
    ).run(now).changes;
  }

  pendingForProjects(projectIds) {
    this.#requireDb();
    this.expireOverdue();
    const ids = Array.isArray(projectIds) ? projectIds.filter(Boolean) : [];
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT * FROM probes
      WHERE state = 'queued' AND project_id IN (${placeholders})
      ORDER BY requested_at ASC
    `).all(...ids).map(probeFromRow);
  }

  claim(probeId, bridgeId, now = new Date().toISOString()) {
    this.#requireDb();
    this.expireOverdue(now);
    const changed = this.db.prepare(`
      UPDATE probes SET state = 'claimed', claimed_by = ?, claimed_at = ?
      WHERE probe_id = ? AND state = 'queued'
    `).run(bridgeId, now, probeId).changes;
    return changed ? this.get(probeId) : null;
  }

  // Return an undelivered claim so another executor can pick it up instead of
  // letting the probe rot until its deadline.
  release(probeId) {
    this.#requireDb();
    return this.db.prepare(`
      UPDATE probes SET state = 'queued', claimed_by = NULL, claimed_at = NULL
      WHERE probe_id = ? AND state = 'claimed'
    `).run(probeId).changes;
  }

  answer(probeId, { verdict, confidence = null, evidence = [], suggestedReply = null } = {}) {
    this.#requireDb();
    const changed = this.db.prepare(`
      UPDATE probes
      SET state = 'answered', verdict = ?, confidence = ?, evidence_json = ?,
          suggested_reply = ?, answered_at = ?
      WHERE probe_id = ? AND state IN ('queued','claimed')
    `).run(
      verdict, confidence == null ? null : Number(confidence), JSON.stringify(evidence ?? []),
      suggestedReply, new Date().toISOString(), probeId,
    ).changes;
    return changed ? this.get(probeId) : null;
  }
}
