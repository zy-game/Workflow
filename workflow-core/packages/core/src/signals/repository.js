// signals/repository.js - the raw observations the assistant learns from.
//
// A signal is an immutable fact ("this message happened"), not an instruction.
// It is deduplicated per channel by its source reference, so a redelivered
// event never doubles as two signals.
import crypto from 'node:crypto';

function signalFromRow(row) {
  return {
    signalId: row.signal_id,
    channel: row.channel,
    sourceRef: row.source_ref,
    kind: row.kind,
    chatRef: row.chat_ref ?? null,
    projectId: row.project_id ?? null,
    senderRef: row.sender_ref ?? null,
    excerpt: row.excerpt ?? null,
    receivedAt: row.received_at,
  };
}

export class SignalRepository {
  constructor({ coreDb }) {
    this.db = coreDb?.db ?? null;
  }

  #requireDb() {
    if (!this.db) throw new Error('signal repository requires coreDb');
  }

  // Returns { signal, created }: a duplicate source reference yields the
  // existing row rather than a second signal.
  record({
    signalId = `sig-${crypto.randomUUID()}`,
    channel, sourceRef, kind = 'ambient',
    chatRef = null, projectId = null, senderRef = null, excerpt = null,
  } = {}) {
    this.#requireDb();
    const existing = this.findBySource(channel, sourceRef);
    if (existing) return { signal: existing, created: false };
    this.db.prepare(`
      INSERT INTO signals (
        signal_id, channel, source_ref, kind, chat_ref, project_id, sender_ref, excerpt, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      signalId, String(channel), String(sourceRef), String(kind),
      chatRef, projectId, senderRef, excerpt, new Date().toISOString(),
    );
    return { signal: this.get(signalId), created: true };
  }

  get(signalId) {
    const row = this.db?.prepare('SELECT * FROM signals WHERE signal_id = ?').get(signalId);
    return row ? signalFromRow(row) : null;
  }

  findBySource(channel, sourceRef) {
    const row = this.db?.prepare('SELECT * FROM signals WHERE channel = ? AND source_ref = ?').get(String(channel), String(sourceRef));
    return row ? signalFromRow(row) : null;
  }

  list({ channel = null, kind = null, limit = 100 } = {}) {
    this.#requireDb();
    const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
    const clauses = [];
    const args = [];
    if (channel) { clauses.push('channel = ?'); args.push(channel); }
    if (kind) { clauses.push('kind = ?'); args.push(kind); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    args.push(bounded);
    return this.db.prepare(`SELECT * FROM signals ${where} ORDER BY received_at DESC LIMIT ?`)
      .all(...args).map(signalFromRow);
  }
}
