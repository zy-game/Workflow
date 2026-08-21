// base.js - SQLite foundation shared by every core database.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function configure(db, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS) {
  db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(busyTimeoutMs))}`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

export function openDatabase(file, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, create = true } = {}) {
  const target = path.resolve(file);
  if (create) fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  configure(db, busyTimeoutMs);
  return db;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function snapshotDatabase(sourceFile, destinationFile) {
  const source = path.resolve(sourceFile);
  const destination = path.resolve(destinationFile);
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) throw new Error(`SQLite snapshot destination already exists: ${destination}`);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    db.exec(`VACUUM INTO ${sqlString(destination)}`);
  } finally {
    db.close();
  }
  return true;
}

export function integritySnapshot(db, expectedVersion) {
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  return {
    ok: integrity.integrity_check === 'ok' && foreignKeys.length === 0 && version === expectedVersion,
    integrity: integrity.integrity_check,
    foreign_key_rows: foreignKeys.length,
    version,
  };
}

// Opens the database, runs schema creation, and guarantees a fresh database plus
// sidecars are removed if initialization fails (never leave a half-built authority).
export function initializeDatabase(file, expectedVersion, createSchema, options = {}) {
  const target = path.resolve(file);
  const databaseExisted = fs.existsSync(target);
  let db = null;
  try {
    db = openDatabase(target, options);
    createSchema(db);
    const snapshot = integritySnapshot(db, expectedVersion);
    if (!snapshot.ok) throw new Error(`database initialization check failed: ${JSON.stringify(snapshot)}`);
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* preserve the original failure */ }
    if (!databaseExisted) {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
    }
    throw error;
  }
}
