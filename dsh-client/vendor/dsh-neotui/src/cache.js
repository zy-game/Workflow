import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ALLOWED_STORES = new Set([
  "projections",
  "revisions",
  "root_mappings",
  "local_fts",
  "code_indexes",
  "cursor",
  "outbox",
  "conflicts",
]);

export function cacheRoot(env = process.env, platform = process.platform) {
  if (env.DSH_TUI_CACHE_HOME) return env.DSH_TUI_CACHE_HOME;
  if (platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required for the NeoTUI cache");
    return join(env.LOCALAPPDATA, "DshTui");
  }
  const base = env.XDG_CACHE_HOME ?? join(env.HOME ?? ".", ".cache");
  return join(base, "dsh-tui");
}

export function cacheFile() {
  return join(cacheRoot(), "cache.db");
}

function storeName(store) {
  if (!ALLOWED_STORES.has(store)) throw new Error(`cache store is not allowed: ${store}`);
  return store;
}

export class CacheRepository {
  constructor(path = cacheFile()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cache_entries (
        store TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store, key)
      );
    `);
  }

  put(store, key, value) {
    store = storeName(store);
    if (/(token|password|credential|secret)/i.test(String(key))) throw new Error("credentials are forbidden in cache.db");
    const json = JSON.stringify(value);
    if (/(access_token|refresh_token|password|authorization)/i.test(json)) throw new Error("credentials are forbidden in cache.db");
    this.db.prepare(`
      INSERT INTO cache_entries(store, key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(store, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(store, String(key), json, Date.now());
  }

  get(store, key) {
    store = storeName(store);
    const row = this.db.prepare("SELECT value_json FROM cache_entries WHERE store = ? AND key = ?").get(store, String(key));
    return row ? JSON.parse(row.value_json) : null;
  }

  delete(store, key) {
    store = storeName(store);
    this.db.prepare("DELETE FROM cache_entries WHERE store = ? AND key = ?").run(store, String(key));
  }

  clear() {
    this.db.exec("DELETE FROM cache_entries");
  }

  close() {
    this.db.close();
  }

  static rebuild(path = cacheFile()) {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
    return new CacheRepository(path);
  }
}

export { ALLOWED_STORES };
