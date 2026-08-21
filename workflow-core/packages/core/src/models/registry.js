// registry.js - model registry over core.db. api_key is stored in plaintext
// by explicit single-user design and is only ever emitted over authenticated
// channels (worker push, admin API) - never into logs or audit rows.
import crypto from 'node:crypto';
import { modelPushEntry, PRIORITY_MIN } from '@workflow-core/shared';
import { transaction } from '../db/base.js';

export const PROBE_FAILURE_DEMOTE_THRESHOLD = 3;

export class ModelRegistry {
  constructor({ coreDb, db } = {}) {
    this.db = db || coreDb.db;
  }

  get revision() {
    return Number(this.db.prepare(
      'SELECT revision FROM model_registry_state WHERE singleton = 1',
    ).get()?.revision ?? 0);
  }

  #rowToModel(row, { includeKey = false } = {}) {
    if (!row) return null;
    const model = {
      model_id: row.model_id,
      provider: row.provider,
      model: row.model,
      base_url: row.base_url,
      priority: Number(row.priority),
      enabled: Number(row.enabled) === 1,
      probe_status: row.probe_status,
      probe_latency_ms: row.probe_latency_ms === null ? null : Number(row.probe_latency_ms),
      probe_error: row.probe_error,
      probe_at: row.probe_at,
      consecutive_failures: Number(row.consecutive_failures),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (includeKey) model.api_key = row.api_key;
    return model;
  }

  upsert({ provider, model, key, baseUrl, priority = 5, enabled = true, model_id = null }) {
    // Validates the exact shape that gets pushed to workers.
    modelPushEntry({ provider, model, key, baseUrl, priority });
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      if (model_id) {
        const changes = this.db.prepare(`
          UPDATE model_registry SET provider = ?, model = ?, api_key = ?, base_url = ?,
          priority = ?, enabled = ?, updated_at = ? WHERE model_id = ?
        `).run(provider, model, key, baseUrl, priority, enabled ? 1 : 0, now, model_id).changes;
        if (!changes) {
          const error = new Error('model entry does not exist');
          error.code = 'MODEL_NOT_FOUND';
          throw error;
        }
        this.#bumpRevision();
        return this.get(model_id, { includeKey: true });
      }
      const id = `mdl-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO model_registry (
          model_id, provider, model, api_key, base_url, priority, enabled,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, provider, model, key, baseUrl, priority, enabled ? 1 : 0, now, now);
      this.#bumpRevision();
      return this.get(id, { includeKey: true });
    });
  }

  remove(modelId) {
    const changes = this.db.prepare('DELETE FROM model_registry WHERE model_id = ?').run(modelId).changes;
    if (!changes) {
      const error = new Error('model entry does not exist');
      error.code = 'MODEL_NOT_FOUND';
      throw error;
    }
    this.#bumpRevision();
    return true;
  }

  get(modelId, { includeKey = false } = {}) {
    return this.#rowToModel(this.db.prepare('SELECT * FROM model_registry WHERE model_id = ?').get(modelId), { includeKey });
  }

  list({ includeKey = false } = {}) {
    return this.db.prepare(
      'SELECT * FROM model_registry ORDER BY enabled DESC, priority ASC, model ASC',
    ).all().map((row) => this.#rowToModel(row, { includeKey }));
  }

  // Ordered push payload: enabled entries, healthy first, then priority.
  // Unhealthy-but-enabled entries stay in the list as lower-priority fallbacks.
  pushList() {
    return this.list({ includeKey: true })
      .filter((entry) => entry.enabled)
      .sort((a, b) => {
        const aHealth = a.probe_status === 'ok' ? 0 : a.probe_status === 'unknown' ? 1 : 2;
        const bHealth = b.probe_status === 'ok' ? 0 : b.probe_status === 'unknown' ? 1 : 2;
        if (aHealth !== bHealth) return aHealth - bHealth;
        return a.priority - b.priority;
      })
      .map((entry, index) => ({
        provider: entry.provider, model: entry.model, key: entry.api_key, baseUrl: entry.base_url,
        priority: index === 0 ? PRIORITY_MIN : entry.priority,
      }));
  }

  recordProbe(modelId, { ok, latencyMs = null, error = null }, { demote = true, demoteThreshold = PROBE_FAILURE_DEMOTE_THRESHOLD } = {}) {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM model_registry WHERE model_id = ?').get(modelId);
      if (!row) {
        const errorNotFound = new Error('model entry does not exist');
        errorNotFound.code = 'MODEL_NOT_FOUND';
        throw errorNotFound;
      }
      const now = new Date().toISOString();
      const failures = ok ? 0 : Number(row.consecutive_failures) + 1;
      let priority = Number(row.priority);
      let enabled = Number(row.enabled) === 1;
      let demoted = false;
      if (demote && !ok && failures >= demoteThreshold) {
        priority = Math.min(9, priority + 1);
        demoted = true;
        if (failures >= demoteThreshold * 2) enabled = false;
      }
      this.db.prepare(`
        UPDATE model_registry SET probe_status = ?, probe_latency_ms = ?, probe_error = ?,
        probe_at = ?, consecutive_failures = ?, priority = ?, enabled = ?, updated_at = ?
        WHERE model_id = ?
      `).run(
        ok ? 'ok' : 'fail', latencyMs === null ? null : Math.round(latencyMs),
        ok ? null : String(error || 'probe failed').slice(0, 300),
        now, failures, priority, enabled ? 1 : 0, now, modelId,
      );
      // Revision drives worker pushes; only ordering-relevant changes (health
      // transition, demotion, disable) may bump it - a routine successful
      // probe of an already-ok model must not churn the counter.
      const statusChanged = row.probe_status !== (ok ? 'ok' : 'fail');
      const enabledChanged = (Number(row.enabled) === 1) !== enabled;
      if (statusChanged || demoted || enabledChanged) this.#bumpRevision();
      return this.get(modelId, { includeKey: true });
    });
  }

  #bumpRevision() {
    this.db.prepare(
      'UPDATE model_registry_state SET revision = revision + 1 WHERE singleton = 1',
    ).run();
  }
}
