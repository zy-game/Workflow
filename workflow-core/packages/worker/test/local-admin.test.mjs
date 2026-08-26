import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from '../src/config-store.js';
import { CredentialStore } from '../src/credential-store.js';
import { EnvironmentStore } from '../src/environment-store.js';

const stubProvider = {
  name: 'stub',
  protect: async (plain) => `enc:${plain}`,
  unprotect: async (encrypted) => encrypted.slice(4),
};

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('credential store persists protected secrets and never exposes values', async () => {
  const dir = tempDir('worker-cred-');
  const store = new CredentialStore({ dataDir: dir, provider: stubProvider });
  await store.set('x', { provider: 'stub', value: 'secret', metadata: { account: 'a' } });
  assert.equal(store.list()[0].provider, 'stub');
  assert.equal(store.list()[0].value, undefined);
  const entry = await store.get('x');
  assert.equal(entry.value, 'secret');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
  assert.equal(raw.x.secret, 'enc:secret');
  assert.equal(raw.x.value, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('credential store supports external references without a local value', async () => {
  const dir = tempDir('worker-cred-ref-');
  const store = new CredentialStore({ dataDir: dir, provider: stubProvider });
  await store.set('r', { name: 'remote', reference: 'systemd://db-password' });
  const entry = await store.get('r');
  assert.equal(entry.kind, 'reference');
  assert.equal(entry.reference, 'systemd://db-password');
  assert.equal(entry.value, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('environment store rejects secret-like keys and non-string values', () => {
  const dir = tempDir('worker-env-');
  const store = new EnvironmentStore({ dataDir: dir });
  assert.throws(() => store.set('bad', { vars: { API_TOKEN: 'x' } }), /not allowed/);
  assert.throws(() => store.set('bad', { vars: { DB_PASSWORD: 'x' } }), /not allowed/);
  assert.throws(() => store.set('bad', { vars: { ACCESS_KEY_ID: 'x' } }), /not allowed/);
  assert.throws(() => store.set('bad', { vars: { WFC_CORE_URL: 'x' } }), /not allowed/);
  assert.throws(() => store.set('bad', { vars: { PORT: 3000 } }), /must be a string/);
  store.set('good', { vars: { PORT: '3000', DATABASE_URL: 'postgres://local/db' } });
  assert.equal(store.get('good').vars.PORT, '3000');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config store bumps revisions and persists projects and backends', () => {
  const dir = tempDir('worker-config-');
  const store = new ConfigStore({ dataDir: dir });
  const root = fs.mkdtempSync(path.join(dir, 'root-'));
  assert.equal(store.get().revision, 0);
  store.addProject({ projectId: 'p1', root });
  store.upsertBackend({ kind: 'workflow-jsonl', command: 'bridge', args: ['--x'], capabilities: ['run'] });
  assert.equal(store.get().revision, 2);
  assert.equal(store.removeProject('p1'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
