// settings-repository.js - server-level KV settings edited on the console.
// Secrets never belong here; they live in worker_credentials (server scope).
import fs from 'node:fs';
import path from 'node:path';

export class SettingsRepository {
  constructor({ coreDb = null, dataDir = null, filename = null } = {}) {
    this.db = coreDb?.db ?? null;
    this.file = filename || (dataDir ? path.join(path.resolve(dataDir), 'server-settings.json') : null);
    this.values = this.file && fs.existsSync(this.file) ? this.#load() : {};
  }

  #load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  #save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(key, fallback = null) {
    if (this.db) {
      const row = this.db.prepare('SELECT value_json FROM server_settings WHERE key = ?').get(key);
      if (row) { try { return JSON.parse(row.value_json); } catch { return fallback; } }
      return fallback;
    }
    return this.values[key] ?? fallback;
  }

  set(key, value) {
    const now = new Date().toISOString();
    if (this.db) {
      this.db.prepare(
        "INSERT INTO server_settings (key, value_json, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      ).run(key, JSON.stringify(value ?? null), now);
      return value ?? null;
    }
    this.values[key] = value ?? null;
    this.#save();
    return value ?? null;
  }
}
