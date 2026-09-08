// ai/applications.js - what a self-optimization change actually did.
//
// Applying a suggestion is a change to the assistant's own configuration, so
// it must be reversible and measurable: the previous value is snapshotted
// before the change, and the metrics at that moment are kept so a later read
// can show whether the change moved anything.
import crypto from 'node:crypto';

function applicationFromRow(row) {
  return {
    applicationId: row.application_id,
    suggestionId: row.suggestion_id,
    targetType: row.target_type,
    targetKey: row.target_key ?? null,
    before: JSON.parse(row.before_json || '{}'),
    after: JSON.parse(row.after_json || '{}'),
    metricsBefore: JSON.parse(row.metrics_before_json || '{}'),
    appliedAt: row.applied_at,
    revertedAt: row.reverted_at ?? null,
  };
}

export class SuggestionApplicationRepository {
  constructor({ coreDb }) {
    this.db = coreDb?.db ?? null;
  }

  #requireDb() {
    if (!this.db) throw new Error('application repository requires coreDb');
  }

  record({
    applicationId = `app-${crypto.randomUUID()}`,
    suggestionId, targetType, targetKey = null,
    before = {}, after = {}, metricsBefore = {},
  } = {}) {
    this.#requireDb();
    this.db.prepare(`
      INSERT INTO suggestion_applications (
        application_id, suggestion_id, target_type, target_key,
        before_json, after_json, metrics_before_json, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      applicationId, String(suggestionId), String(targetType), targetKey,
      JSON.stringify(before ?? {}), JSON.stringify(after ?? {}), JSON.stringify(metricsBefore ?? {}),
      new Date().toISOString(),
    );
    return this.get(applicationId);
  }

  get(applicationId) {
    const row = this.db?.prepare('SELECT * FROM suggestion_applications WHERE application_id = ?').get(applicationId);
    return row ? applicationFromRow(row) : null;
  }

  list({ limit = 50 } = {}) {
    this.#requireDb();
    const bounded = Math.min(200, Math.max(1, Number(limit) || 50));
    return this.db.prepare('SELECT * FROM suggestion_applications ORDER BY applied_at DESC LIMIT ?')
      .all(bounded).map(applicationFromRow);
  }

  markReverted(applicationId) {
    this.#requireDb();
    const changed = this.db.prepare(
      'UPDATE suggestion_applications SET reverted_at = ? WHERE application_id = ? AND reverted_at IS NULL',
    ).run(new Date().toISOString(), applicationId).changes;
    return changed ? this.get(applicationId) : null;
  }
}

// A before/after view of the assistant metrics. Only the rates are compared:
// raw counts drift with traffic, so a rate is the honest signal.
const RATE_PATHS = [
  ['proposals', 'approval_rate'],
  ['proposals', 'rejection_rate'],
  ['resolution', 'auto_rate'],
  ['replies', 'veto_rate'],
];

function rateAt(metrics, [group, key]) {
  const value = metrics?.[group]?.[key];
  return typeof value === 'number' ? value : null;
}

export function metricsDelta(before, after) {
  const changes = [];
  for (const path of RATE_PATHS) {
    const from = rateAt(before, path);
    const to = rateAt(after, path);
    if (from == null || to == null) continue;
    changes.push({
      metric: `${path[0]}.${path[1]}`,
      before: from,
      after: to,
      delta: Number((to - from).toFixed(3)),
      // A rising rejection rate or veto rate is worse, not better.
      improved: path[1] === 'rejection_rate' || path[1] === 'veto_rate' ? to < from : to > from,
    });
  }
  return changes;
}
