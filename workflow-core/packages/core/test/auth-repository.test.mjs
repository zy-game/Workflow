import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { hashPassword, verifyPassword } from '../src/auth/crypto.js';

let dir;
let repo;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-auth-'));
  repo = new AuthRepository({ dataDir: dir });
});

after(() => {
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('creates accounts with scrypt v1 hashes that verify', async () => {
  const account = await repo.createAccount({ email: 'Owner@Example.com', password: 'correct-horse-battery' });
  assert.equal(account.email, 'owner@example.com');
  assert.equal(account.role, 'admin');
  assert.match(account.password_hash, /^scrypt\$v=1\$N=32768,r=8,p=1\$/);
  assert.ok(await verifyPassword('correct-horse-battery', account.password_hash));
  assert.equal(await verifyPassword('wrong-password-123', account.password_hash), false);
});

test('rejects duplicate emails, weak passwords, and malformed input', async () => {
  await assert.rejects(() => repo.createAccount({ email: 'owner@example.com', password: 'correct-horse-battery' }), /already exists/);
  await assert.rejects(() => repo.createAccount({ email: 'new@example.com', password: 'short' }), /characters/);
  await assert.rejects(() => repo.createAccount({ email: 'not-an-email', password: 'correct-horse-battery' }), /format/);
});

test('hashPassword output round-trips through the repository verification path', async () => {
  const hash = await hashPassword('another-valid-passphrase');
  assert.ok(await verifyPassword('another-valid-passphrase', hash));
  assert.equal(await verifyPassword('another-valid-passphras', hash), false);
});

test('client tokens are opaque, verifiable, and revocable', () => {
  const account = repo.getAccountByEmail('owner@example.com');
  const issued = repo.createClientAccessToken(account, 60_000);
  assert.match(issued.token, /^wfc-/);
  const resolved = repo.getClientAccessToken(issued.token);
  assert.equal(resolved.principal.account_id, account.account_id);
  assert.equal(repo.getClientAccessToken('wfc-forged-token-value'), null);
  assert.equal(repo.revokeClientAccessToken(issued.token), true);
  assert.equal(repo.getClientAccessToken(issued.token), null);
});

test('machine tokens carry role actions and become principals', () => {
  const { token, record } = repo.createMachineToken({ subject_id: 'win-main', role: 'worker' });
  assert.ok(record.actions.includes('task:claim'));
  assert.ok(record.actions.includes('session_event:write'));
  const resolved = repo.getMachineToken(token);
  assert.equal(resolved.principal.subject_id, 'machine:win-main');
  assert.equal(resolved.principal.auth_type, 'machine');
  const revoked = repo.revokeMachineToken(record.token_id);
  assert.ok(revoked.revoked_at);
  assert.equal(repo.getMachineToken(token), null);
});

test('browser sessions are ip-bound and a foreign-ip probe invalidates them', () => {
  const account = repo.getAccountByEmail('owner@example.com');
  const session = repo.createBrowserSession(account, '127.0.0.1', 60_000);
  const resolved = repo.getBrowserSession(session.id, '127.0.0.1');
  assert.equal(resolved.principal.email, 'owner@example.com');
  // A probe from a different address both fails and invalidates the session.
  assert.equal(repo.getBrowserSession(session.id, '10.0.0.9'), null);
  assert.equal(repo.getBrowserSession(session.id, '127.0.0.1'), null);
});

test('fresh databases initialize cleanly and reopen as existing authority', () => {
  assert.equal(repo.integrityCheck().ok, true);
  assert.equal(repo.integrityCheck().version, 1);

  const reopenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-auth-reopen-'));
  try {
    const first = new AuthRepository({ dataDir: reopenDir });
    first.close();
    // Reopening the same file must not treat it as fresh (no sidecar wipe).
    const second = new AuthRepository({ dataDir: reopenDir });
    assert.equal(second.integrityCheck().ok, true);
    assert.equal(second.accountCount(), 0);
    second.close();
  } finally {
    fs.rmSync(reopenDir, { recursive: true, force: true });
  }
});
