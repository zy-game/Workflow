// replies/repository.js - what the assistant said, on the record.
//
// Every outbound reply is written here with the tier, the autonomy that
// allowed it, and the evidence behind it. Without this row a reply must not
// be sent at all. The same file records the user's reaction as feedback, which
// the self-optimization loop reads later.
import crypto from 'node:crypto';

export const FEEDBACK_SIGNALS = ['approve', 'veto', 'ignore', 'drop', 'correct'];

function replyFromRow(row) {
  return {
    replyId: row.reply_id,
    proposalId: row.proposal_id ?? null,
    channel: row.channel,
    channelTarget: row.channel_target,
    messageRef: row.message_ref ?? null,
    tier: row.tier,
    autonomy: row.autonomy,
    vetoed: row.vetoed === 1,
    evidence: JSON.parse(row.evidence_json || '[]'),
    text: row.text,
    createdAt: row.created_at,
  };
}

export class ReplyRepository {
  constructor({ coreDb }) {
    this.db = coreDb?.db ?? null;
  }

  #requireDb() {
    if (!this.db) throw new Error('reply repository requires coreDb');
  }

  record({
    replyId = `reply-${crypto.randomUUID()}`,
    proposalId = null,
    channel,
    channelTarget,
    messageRef = null,
    tier,
    autonomy,
    vetoed = false,
    evidence = [],
    text,
  } = {}) {
    this.#requireDb();
    this.db.prepare(`
      INSERT INTO reply_log (
        reply_id, proposal_id, channel, channel_target, message_ref,
        tier, autonomy, vetoed, evidence_json, text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      replyId, proposalId, String(channel), String(channelTarget), messageRef,
      String(tier), String(autonomy), vetoed ? 1 : 0, JSON.stringify(evidence ?? []),
      String(text), new Date().toISOString(),
    );
    return this.get(replyId);
  }

  get(replyId) {
    const row = this.db?.prepare('SELECT * FROM reply_log WHERE reply_id = ?').get(replyId);
    return row ? replyFromRow(row) : null;
  }

  list({ limit = 100 } = {}) {
    this.#requireDb();
    const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.db.prepare('SELECT * FROM reply_log ORDER BY created_at DESC LIMIT ?').all(bounded).map(replyFromRow);
  }

  // A proposal is delivered once; this is the idempotency key for the sender.
  forProposal(proposalId) {
    const row = this.db?.prepare('SELECT * FROM reply_log WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1').get(proposalId);
    return row ? replyFromRow(row) : null;
  }

  attachMessageRef(replyId, messageRef) {
    this.#requireDb();
    this.db.prepare('UPDATE reply_log SET message_ref = ? WHERE reply_id = ?').run(messageRef, replyId);
    return this.get(replyId);
  }

  addFeedback({ subjectType, subjectRef, signal, source = null }) {
    this.#requireDb();
    if (!FEEDBACK_SIGNALS.includes(signal)) throw new TypeError(`unsupported feedback signal: ${signal}`);
    const id = `fb-${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO feedback (feedback_id, subject_type, subject_ref, signal, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, String(subjectType), String(subjectRef), String(signal), source, new Date().toISOString());
    return { feedbackId: id, subjectType, subjectRef, signal, source };
  }

  feedbackFor(subjectRef) {
    return this.db?.prepare('SELECT * FROM feedback WHERE subject_ref = ? ORDER BY created_at ASC').all(String(subjectRef)) ?? [];
  }
}
