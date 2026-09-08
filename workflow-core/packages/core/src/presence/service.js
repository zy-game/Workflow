// presence/service.js - where the user is, as reported by the touchpoints
// themselves.
//
// The server never guesses: each client reports facts (its own idle bucket and
// the project it is showing), and the server derives which touchpoint is most
// likely to be in front of the user. That keeps the decision auditable and
// stops a stale client from claiming presence it does not have.
//
// Notifications are broadcast to every live touchpoint; the first one to
// acknowledge wins, and the others suppress. Presence is cheap enough to be
// wrong occasionally, but a duplicate notification on three screens is not.
export const IDLE_BUCKETS = ['active', 'recent', 'idle', 'unknown'];
export const TOUCHPOINT_KINDS = ['browser', 'desktop', 'phone'];
export const DEFAULT_PRESENCE_TTL_MS = 90_000;

// Louder first: a touchpoint the user just interacted with is the best target.
const BUCKET_RANK = { active: 0, recent: 1, idle: 2, unknown: 3 };

function presenceFromRow(row) {
  return {
    touchpointId: row.touchpoint_id,
    kind: row.kind,
    idleBucket: row.idle_bucket,
    activeProject: row.active_project ?? null,
    lastSeen: row.last_seen,
    expiresAt: row.expires_at,
  };
}

export class PresenceRepository {
  constructor({ coreDb }) {
    this.db = coreDb?.db ?? null;
  }

  #requireDb() {
    if (!this.db) throw new Error('presence repository requires coreDb');
  }

  upsert({ touchpointId, kind, idleBucket, activeProject = null, ttlMs, now = new Date() }) {
    this.#requireDb();
    const seen = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.db.prepare(`
      INSERT INTO presence (touchpoint_id, kind, idle_bucket, active_project, last_seen, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(touchpoint_id) DO UPDATE SET
        kind = excluded.kind, idle_bucket = excluded.idle_bucket,
        active_project = excluded.active_project, last_seen = excluded.last_seen,
        expires_at = excluded.expires_at
    `).run(touchpointId, kind, idleBucket, activeProject, seen, expiresAt);
    return presenceFromRow(this.db.prepare('SELECT * FROM presence WHERE touchpoint_id = ?').get(touchpointId));
  }

  live(now = new Date()) {
    this.#requireDb();
    return this.db.prepare('SELECT * FROM presence WHERE expires_at > ? ORDER BY last_seen DESC')
      .all(now.toISOString()).map(presenceFromRow);
  }

  // Drop anything that has stopped reporting; called lazily on every read so a
  // crashed client cannot linger forever.
  purge(now = new Date()) {
    this.#requireDb();
    return this.db.prepare('DELETE FROM presence WHERE expires_at <= ?').run(now.toISOString()).changes;
  }

  ack(notificationId, touchpointId, now = new Date().toISOString()) {
    this.#requireDb();
    this.db.prepare(
      'INSERT OR IGNORE INTO presence_acks (notification_id, touchpoint_id, created_at) VALUES (?, ?, ?)',
    ).run(String(notificationId), String(touchpointId), now);
    const row = this.db.prepare('SELECT * FROM presence_acks WHERE notification_id = ?').get(String(notificationId));
    return row ? { notificationId: row.notification_id, touchpointId: row.touchpoint_id, createdAt: row.created_at } : null;
  }

  ackedBy(notificationId) {
    const row = this.db?.prepare('SELECT touchpoint_id FROM presence_acks WHERE notification_id = ?').get(String(notificationId));
    return row ? row.touchpoint_id : null;
  }
}

export function createPresenceService({ presenceRepository, ttlMs = DEFAULT_PRESENCE_TTL_MS } = {}) {
  if (!presenceRepository) throw new TypeError('presenceRepository is required');

  function report({ touchpoint_id: touchpointId, kind = 'browser', idle_bucket: idleBucket = 'unknown', active_project: activeProject = null } = {}) {
    if (!touchpointId) throw new TypeError('touchpoint_id is required');
    if (!TOUCHPOINT_KINDS.includes(kind)) throw new TypeError(`unsupported touchpoint kind: ${kind}`);
    const bucket = IDLE_BUCKETS.includes(idleBucket) ? idleBucket : 'unknown';
    return presenceRepository.upsert({
      touchpointId: String(touchpointId), kind, idleBucket: bucket,
      activeProject: activeProject ? String(activeProject) : null, ttlMs,
    });
  }

  function online() {
    presenceRepository.purge();
    return presenceRepository.live();
  }

  // The touchpoint most likely to be in front of the user. Ties break by most
  // recent report, which is the only other signal the server has.
  function active() {
    const live = online();
    if (!live.length) return null;
    return [...live].sort((a, b) => (
      (BUCKET_RANK[a.idleBucket] ?? 9) - (BUCKET_RANK[b.idleBucket] ?? 9)
      || String(b.lastSeen).localeCompare(String(a.lastSeen))
    ))[0];
  }

  function ack({ notificationId, touchpointId }) {
    if (!notificationId || !touchpointId) throw new TypeError('notificationId and touchpointId are required');
    return presenceRepository.ack(notificationId, touchpointId);
  }

  return {
    report,
    online,
    active,
    ack,
    ackedBy: (notificationId) => presenceRepository.ackedBy(notificationId),
    ttlMs,
  };
}
