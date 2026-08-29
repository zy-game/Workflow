// repository.js - auth.db authority: accounts, browser sessions, TUI client
// tokens, machine tokens, audit. Schema-compatible with the previous wf-api
// auth.db (schema v1) so the production database carries over unchanged.
import crypto from 'node:crypto';
import path from 'node:path';
import { initializeDatabase, transaction } from '../db/base.js';
import {
  createAccountPrincipal, createRandomToken, digestToken, newAccountId, normalizeEmail,
  randomToken, validatePassword, hashPassword,
} from './crypto.js';

export const AUTH_DB_FILE = 'auth.db';
export const AUTH_DB_SCHEMA_VERSION = 1;

const MACHINE_ROLE_ACTIONS = Object.freeze({
  worker: Object.freeze([
    'worker:register', 'worker:heartbeat', 'task:read',
    'knowledge:read', 'knowledge:write',
  ]),
  bridge: Object.freeze([
    'bridge:register', 'bridge:pull', 'bridge:heartbeat',
    'bridge:events', 'bridge:result', 'bridge:release',
  ]),
  'ai-manager': Object.freeze([
    'task:create', 'task:read', 'task:cancel', 'model:read', 'model:write',
    'knowledge:read', 'knowledge:write', 'worker:read', 'decision:write',
  ]),
  feishu: Object.freeze(['task:create', 'task:read', 'task:cancel', 'interaction:respond', 'outbound:*']),
  peer: Object.freeze(['peer:sync', 'task:read']),
  admin: Object.freeze(['*']),
});

const MACHINE_ROLES = new Set([...Object.keys(MACHINE_ROLE_ACTIONS), 'service']);

function createSchema(db) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        display_name TEXT,
        project_ids_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        credential_version INTEGER NOT NULL CHECK (credential_version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT,
        last_login_at TEXT,
        disabled_at TEXT,
        disabled_by TEXT
      );
      CREATE TABLE IF NOT EXISTS browser_sessions (
        session_digest TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        credential_version INTEGER NOT NULL,
        csrf_token TEXT NOT NULL,
        ip TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS browser_sessions_account_idx ON browser_sessions(account_id);
      CREATE INDEX IF NOT EXISTS browser_sessions_expires_idx ON browser_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS client_access_tokens (
        token_id TEXT PRIMARY KEY,
        token_digest TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        credential_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS client_access_tokens_account_idx ON client_access_tokens(account_id);
      CREATE TABLE IF NOT EXISTS machine_tokens (
        token_id TEXT PRIMARY KEY,
        token_digest TEXT NOT NULL UNIQUE,
        subject_id TEXT NOT NULL,
        role TEXT NOT NULL,
        project_ids_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        last_used_at TEXT,
        rotated_from TEXT
      );
      CREATE TABLE IF NOT EXISTS bootstrap_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
        token_digest TEXT,
        created_at TEXT,
        expires_at TEXT,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS auth_audit (
        event_id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        account_id TEXT,
        email TEXT,
        ip TEXT,
        actor TEXT,
        reason TEXT,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS auth_audit_ts_idx ON auth_audit(ts);
      CREATE INDEX IF NOT EXISTS auth_audit_type_idx ON auth_audit(type);
      CREATE TABLE IF NOT EXISTS migration_metadata (
        migration_key TEXT PRIMARY KEY,
        source_path TEXT,
        source_sha256 TEXT,
        imported_at TEXT NOT NULL,
        imported_rows INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      INSERT OR IGNORE INTO bootstrap_state (
        singleton, completed, token_digest, created_at, expires_at, completed_at
      ) VALUES (1, 0, NULL, NULL, NULL, NULL);
      PRAGMA user_version = ${AUTH_DB_SCHEMA_VERSION};
    `);
  });
}

function accountFromRow(row) {
  if (!row) return null;
  return {
    account_id: row.account_id,
    email: row.email,
    password_hash: row.password_hash,
    role: row.role,
    status: row.status,
    display_name: row.display_name,
    project_ids: JSON.parse(row.project_ids_json || '[]'),
    actions: JSON.parse(row.actions_json || '[]'),
    credential_version: Number(row.credential_version),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
    disabled_at: row.disabled_at,
    disabled_by: row.disabled_by,
  };
}

function machineTokenFromRow(row) {
  if (!row) return null;
  return {
    token_id: row.token_id, subject_id: row.subject_id, role: row.role,
    project_ids: JSON.parse(row.project_ids_json || '[]'),
    actions: JSON.parse(row.actions_json || '[]'),
    created_at: row.created_at, expires_at: row.expires_at, revoked_at: row.revoked_at,
    last_used_at: row.last_used_at, rotated_from: row.rotated_from,
  };
}

export function machineActionsForRole(role) {
  return [...(MACHINE_ROLE_ACTIONS[role] || [])];
}

function insertAudit(db, event) {
  const known = new Set(['event_id', 'ts', 'type', 'account_id', 'email', 'ip', 'actor', 'reason']);
  const details = Object.fromEntries(Object.entries(event).filter(([key]) => !known.has(key)));
  const eventId = event.event_id || `ae-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT OR IGNORE INTO auth_audit (
      event_id, ts, type, account_id, email, ip, actor, reason, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId, new Date(event.ts || Date.now()).toISOString(), String(event.type || 'auth_event'),
    event.account_id || null, event.email || null, event.ip || null,
    event.actor || null, event.reason || null, JSON.stringify(details),
  );
}

export class AuthRepository {
  constructor({ dataDir, dbFile, busyTimeoutMs } = {}) {
    const dir = path.resolve(dataDir);
    this.file = path.resolve(dbFile || path.join(dir, AUTH_DB_FILE));
    this.db = initializeDatabase(this.file, AUTH_DB_SCHEMA_VERSION, createSchema, { busyTimeoutMs });
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  accountCount() {
    return Number(this.db.prepare('SELECT count(*) AS count FROM accounts').get().count);
  }

  async createAccount({ email, password, role = 'admin', display_name = null }) {
    const normalizedEmail = normalizeEmail(email);
    validatePassword(password, normalizedEmail);
    if (this.getAccountByEmail(normalizedEmail)) {
      const error = new Error('account already exists');
      error.code = 'ACCOUNT_EXISTS';
      throw error;
    }
    const passwordHash = await hashPassword(password, normalizedEmail);
    const accountId = newAccountId();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO accounts (
        account_id, email, password_hash, role, status, display_name, project_ids_json,
        actions_json, credential_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 1, ?, ?)
    `).run(
      accountId, normalizedEmail, passwordHash, role, display_name,
      JSON.stringify(role === 'admin' ? ['*'] : []), JSON.stringify(role === 'admin' ? ['*'] : []),
      now, now,
    );
    insertAudit(this.db, { type: 'account.created', account_id: accountId, email: normalizedEmail, actor: 'cli' });
    return this.getAccountById(accountId);
  }

  getAccountByEmail(email) {
    return accountFromRow(this.db.prepare('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE').get(email));
  }

  getAccountById(accountId) {
    return accountFromRow(this.db.prepare('SELECT * FROM accounts WHERE account_id = ?').get(accountId));
  }

  listAccounts() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY created_at, account_id').all().map(accountFromRow);
  }

  recordLogin(accountId) {
    this.db.prepare('UPDATE accounts SET last_login_at = ? WHERE account_id = ?')
      .run(new Date().toISOString(), accountId);
  }

  createBrowserSession(account, ip, maxAgeMs) {
    const id = 'as-' + randomToken(32);
    const csrfToken = randomToken(32);
    const now = Date.now();
    const expiresAt = now + maxAgeMs;
    this.db.prepare(`
      INSERT INTO browser_sessions (
        session_digest, account_id, credential_version, csrf_token, ip, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      digestToken(id), account.account_id, account.credential_version || 1, csrfToken,
      ip, new Date(now).toISOString(), new Date(expiresAt).toISOString(),
    );
    return { id, csrfToken, expiresAt, principal: createAccountPrincipal(account) };
  }

  getBrowserSession(id) {
    if (!id) return null;
    const row = this.db.prepare(`
      SELECT s.*, a.email, a.password_hash, a.role, a.status, a.display_name,
        a.project_ids_json, a.actions_json,
        a.credential_version AS account_credential_version
      FROM browser_sessions s JOIN accounts a ON a.account_id = s.account_id
      WHERE s.session_digest = ?
    `).get(digestToken(id));
    if (!row) return null;
    if (row.expires_at <= new Date().toISOString() || row.status !== 'active'
      || Number(row.credential_version) !== Number(row.account_credential_version)) {
      this.deleteBrowserSession(id);
      return null;
    }
    const account = accountFromRow({ ...row, credential_version: row.account_credential_version });
    return {
      account_id: row.account_id, credential_version: Number(row.credential_version),
      csrf_token: row.csrf_token, expires_at: Date.parse(row.expires_at), ip: row.ip,
      principal: createAccountPrincipal(account), account,
    };
  }

  deleteBrowserSession(id) {
    if (!id) return false;
    return this.db.prepare('DELETE FROM browser_sessions WHERE session_digest = ?')
      .run(digestToken(id)).changes > 0;
  }

  createClientAccessToken(account, maxAgeMs) {
    const { token } = createRandomToken(32);
    const prefixed = 'wfc-' + token;
    const digest = digestToken(prefixed);
    const now = Date.now();
    const expiresAt = new Date(now + maxAgeMs).toISOString();
    const tokenId = `cat-${digest.slice(0, 16)}`;
    this.db.prepare(`
      INSERT INTO client_access_tokens (
        token_id, token_digest, account_id, credential_version, created_at, expires_at, revoked_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(tokenId, digest, account.account_id, account.credential_version || 1, new Date(now).toISOString(), expiresAt);
    return { token: prefixed, tokenId, expiresAt };
  }

  getClientAccessToken(token, updateLastUsed = true) {
    if (typeof token !== 'string' || !token) return null;
    const row = this.db.prepare(`
      SELECT t.token_id, t.account_id, t.credential_version AS token_credential_version,
        t.expires_at AS token_expires_at, t.revoked_at, a.*
      FROM client_access_tokens t JOIN accounts a ON a.account_id = t.account_id
      WHERE t.token_digest = ?
    `).get(digestToken(token));
    if (!row || row.revoked_at || row.token_expires_at <= new Date().toISOString()
      || row.status !== 'active' || Number(row.token_credential_version) !== Number(row.credential_version)) return null;
    if (updateLastUsed) {
      this.db.prepare('UPDATE client_access_tokens SET last_used_at = ? WHERE token_id = ?')
        .run(new Date().toISOString(), row.token_id);
    }
    const account = accountFromRow(row);
    return {
      token_id: row.token_id, account_id: row.account_id, expires_at: row.token_expires_at,
      principal: createAccountPrincipal(account), account,
    };
  }

  revokeClientAccessToken(token) {
    if (typeof token !== 'string' || !token) return false;
    return this.db.prepare(`
      UPDATE client_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_digest = ?
    `).run(new Date().toISOString(), digestToken(token)).changes > 0;
  }

  getMachineToken(token, updateLastUsed = true) {
    if (typeof token !== 'string' || !token) return null;
    const row = this.db.prepare('SELECT * FROM machine_tokens WHERE token_digest = ?').get(digestToken(token));
    if (!row || row.revoked_at || (row.expires_at && row.expires_at <= new Date().toISOString())) return null;
    if (updateLastUsed) {
      this.db.prepare('UPDATE machine_tokens SET last_used_at = ? WHERE token_id = ?')
        .run(new Date().toISOString(), row.token_id);
    }
    return {
      ...machineTokenFromRow(row), digest: row.token_digest,
      principal: {
        subject_id: `machine:${row.subject_id}`,
        token_id: row.token_id,
        role: row.role,
        project_ids: JSON.parse(row.project_ids_json || '[]'),
        actions: JSON.parse(row.actions_json || '[]'),
        auth_type: 'machine',
      },
    };
  }

  createMachineToken({ subject_id, role, project_ids = [], actions = [], expires_at = null }) {
    if (!subject_id || typeof subject_id !== 'string') throw new TypeError('subject_id is required');
    if (typeof role !== 'string' || !MACHINE_ROLES.has(role)) throw new TypeError(`unsupported machine role: ${role}`);
    const { token, digest } = createRandomToken(32);
    const tokenId = `mt-${digest.slice(0, 16)}`;
    const roleActions = machineActionsForRole(role);
    const resolvedActions = role === 'bridge'
      ? roleActions
      : [...new Set([...actions, ...roleActions])];
    this.db.prepare(`
      INSERT INTO machine_tokens (
        token_id, token_digest, subject_id, role, project_ids_json, actions_json,
        created_at, expires_at, revoked_at, last_used_at, rotated_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(
      tokenId, digest, subject_id, role, JSON.stringify(project_ids),
      JSON.stringify(resolvedActions), new Date().toISOString(), expires_at,
    );
    insertAudit(this.db, { type: 'machine_token.created', actor: 'admin', reason: subject_id, details: { role, token_id: tokenId } });
    return { token, token_id: tokenId, record: this.getMachineTokenById(tokenId) };
  }

  getMachineTokenById(tokenId) {
    return machineTokenFromRow(this.db.prepare('SELECT * FROM machine_tokens WHERE token_id = ?').get(tokenId));
  }

  listMachineTokens() {
    return this.db.prepare('SELECT * FROM machine_tokens ORDER BY created_at, token_id').all().map(machineTokenFromRow);
  }

  revokeMachineToken(tokenId) {
    const current = this.getMachineTokenById(tokenId);
    if (!current) return null;
    this.db.prepare('UPDATE machine_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_id = ?')
      .run(new Date().toISOString(), tokenId);
    insertAudit(this.db, { type: 'machine_token.revoked', actor: 'admin', reason: tokenId });
    return this.getMachineTokenById(tokenId);
  }

  appendAudit(event) {
    transaction(this.db, () => insertAudit(this.db, event));
  }

  listAudit(limit = 100, typeFilter = null) {
    const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = typeFilter
      ? this.db.prepare('SELECT * FROM auth_audit WHERE type LIKE ? ORDER BY ts DESC LIMIT ?').all(`%${typeFilter}%`, bounded)
      : this.db.prepare('SELECT * FROM auth_audit ORDER BY ts DESC LIMIT ?').all(bounded);
    return rows.map((row) => ({
      ...JSON.parse(row.details_json || '{}'), event_id: row.event_id, ts: row.ts, type: row.type,
      account_id: row.account_id, email: row.email, ip: row.ip, actor: row.actor, reason: row.reason,
    }));
  }

  integrityCheck() {
    const integrity = this.db.prepare('PRAGMA integrity_check').get();
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all();
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    return {
      ok: integrity.integrity_check === 'ok' && foreignKeys.length === 0 && version === AUTH_DB_SCHEMA_VERSION,
      version,
    };
  }
}
