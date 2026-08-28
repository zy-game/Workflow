import crypto from 'node:crypto';

// suggestions-repository.js - AI system-intelligence suggestions with a
// human-approval gate. AI never mutates the system directly: it proposes
// (target_type + payload), the admin approves on the console, the platform
// applies it (skill/knowledge/settings/rule), and feedback metrics close the
// loop for the next checkup.
export function suggestionFromRow(row) {
  return {
    suggestionId: row.suggestion_id,
    targetType: row.target_type,
    title: row.title,
    summary: row.summary,
    payload: JSON.parse(row.payload_json || '{}'),
    status: row.status,
    reason: row.reason,
    metrics: JSON.parse(row.metrics_json || '{}'),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class SuggestionsRepository {
  constructor({ coreDb }) {
    this.db = coreDb?.db ?? null;
  }

  #requireDb() {
    if (!this.db) throw new Error('suggestions repository requires coreDb');
  }

  create({ targetType, title, summary, payload = {}, reason = null, metrics = {} }) {
    this.#requireDb();
    const id = `sug-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO ai_suggestions (suggestion_id, target_type, title, summary, payload_json, status, reason, metrics_json, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, targetType, String(title), String(summary), JSON.stringify(payload), reason, JSON.stringify(metrics), now);
    return this.get(id);
  }

  get(id) {
    const row = this.db?.prepare('SELECT * FROM ai_suggestions WHERE suggestion_id = ?').get(id);
    return row ? suggestionFromRow(row) : null;
  }

  list({ status = null, limit = 100 } = {}) {
    this.#requireDb();
    const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = status
      ? this.db.prepare('SELECT * FROM ai_suggestions WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, bounded)
      : this.db.prepare('SELECT * FROM ai_suggestions ORDER BY created_at DESC LIMIT ?').all(bounded);
    return rows.map(suggestionFromRow);
  }

  resolve(id, status, reason = null) {
    const existing = this.get(id);
    if (!existing) return null;
    this.db.prepare('UPDATE ai_suggestions SET status = ?, resolved_at = ?, reason = COALESCE(?, reason) WHERE suggestion_id = ?')
      .run(status, new Date().toISOString(), reason, id);
    return this.get(id);
  }

  stats() {
    const row = this.db?.prepare(
      "SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending, SUM(status = 'approved') AS approved FROM ai_suggestions",
    ).get();
    return { total: Number(row?.total ?? 0), pending: Number(row?.pending ?? 0), approved: Number(row?.approved ?? 0) };
  }
}
