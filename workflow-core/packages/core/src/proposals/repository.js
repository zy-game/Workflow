// proposals/repository.js - decisions waiting on the user.
//
// A proposal is not a system improvement: it asks whether the assistant should
// take an action (reply in a channel, start work), so it lives in its own
// table rather than mixing with the checkup's ai_suggestions. Mixing them
// would let the self-optimization loop treat "should I answer this group
// message" as a system defect.
import crypto from 'node:crypto';

export const PROPOSAL_STATES = ['pending', 'approved', 'rejected'];

function proposalFromRow(row) {
  return {
    proposalId: row.proposal_id,
    sourceType: row.source_type,
    sourceRef: row.source_ref ?? null,
    projectId: row.project_id ?? null,
    channelTarget: row.channel_target ?? null,
    title: row.title,
    ask: row.ask,
    options: JSON.parse(row.options_json || '[]'),
    draftText: row.draft_text ?? null,
    evidence: JSON.parse(row.evidence_json || '[]'),
    urgency: row.urgency,
    confidence: row.confidence == null ? null : Number(row.confidence),
    state: row.state,
    decision: row.decision ?? null,
    vetoDeadline: row.veto_deadline ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

export class ProposalRepository {
  constructor({ coreDb }) {
    this.db = coreDb?.db ?? null;
  }

  #requireDb() {
    if (!this.db) throw new Error('proposal repository requires coreDb');
  }

  create({
    proposalId = `prop-${crypto.randomUUID()}`,
    sourceType = 'manual',
    sourceRef = null,
    projectId = null,
    channelTarget = null,
    title,
    ask,
    options = [],
    draftText = null,
    evidence = [],
    urgency = 'normal',
    confidence = null,
    vetoDeadline = null,
  } = {}) {
    this.#requireDb();
    this.db.prepare(`
      INSERT INTO proposals (
        proposal_id, source_type, source_ref, project_id, channel_target,
        title, ask, options_json, draft_text, evidence_json, urgency,
        confidence, state, veto_deadline, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      proposalId, String(sourceType), sourceRef, projectId, channelTarget,
      String(title), String(ask), JSON.stringify(options ?? []), draftText,
      JSON.stringify(evidence ?? []), String(urgency),
      confidence == null ? null : Number(confidence), vetoDeadline,
      new Date().toISOString(),
    );
    return this.get(proposalId);
  }

  get(proposalId) {
    const row = this.db?.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(proposalId);
    return row ? proposalFromRow(row) : null;
  }

  list({ state = null, limit = 100 } = {}) {
    this.#requireDb();
    const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = state
      ? this.db.prepare('SELECT * FROM proposals WHERE state = ? ORDER BY created_at DESC LIMIT ?').all(state, bounded)
      : this.db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?').all(bounded);
    return rows.map(proposalFromRow);
  }

  decide(proposalId, { state, decision = 'user' } = {}) {
    this.#requireDb();
    if (!['approved', 'rejected'].includes(state)) throw new TypeError('state must be approved or rejected');
    const changed = this.db.prepare(`
      UPDATE proposals SET state = ?, decision = ?, resolved_at = ?
      WHERE proposal_id = ? AND state = 'pending'
    `).run(state, decision, new Date().toISOString(), proposalId).changes;
    return changed ? this.get(proposalId) : null;
  }

  // The veto window means "send unless vetoed": a pending proposal whose
  // deadline passed is approved by timeout, not rejected.
  expireDue(now = new Date().toISOString()) {
    this.#requireDb();
    const due = this.db.prepare(`
      SELECT proposal_id FROM proposals
      WHERE state = 'pending' AND veto_deadline IS NOT NULL AND veto_deadline <= ?
      ORDER BY veto_deadline ASC
    `).all(now);
    const resolved = [];
    for (const row of due) {
      const decided = this.decide(row.proposal_id, { state: 'approved', decision: 'timeout' });
      if (decided) resolved.push(decided);
    }
    return resolved;
  }
}
