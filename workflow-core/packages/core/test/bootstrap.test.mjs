// bootstrap.test.mjs - first-run setup. A fresh install has no way in, so the
// console offers one - but only while no active account exists, and only with a
// one-time code the operator prints on the server. A publicly reachable console
// must never be claimable by a stranger.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { TaskRepository } from '../src/tasks/repository.js';

let dir;
let auth;
let coreDb;
let server;
let base;

async function call(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-bootstrap-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDb = new CoreDatabase({ dataDir: dir });
  const app = createCoreServer({
    config: {}, authRepository: auth, taskRepository: new TaskRepository({ coreDb }),
  });
  server = await app.listen({ host: '127.0.0.1', port: 0, tls: null });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  coreDb.close();
  auth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh install reports that setup is needed', async () => {
  const status = await call('GET', '/api/v1/auth/bootstrap');
  assert.equal(status.status, 200);
  assert.equal(status.body.needed, true);
  assert.equal(status.body.activeAccounts, 0);
});

test('there is no unauthenticated way to create an account', async () => {
  // The console is publicly reachable; the first admin comes from the service
  // environment, so nothing here may create one.
  const attempt = await call('POST', '/api/v1/auth/bootstrap', { email: 'x@example.com', password: 'whatever-123456' });
  assert.ok(attempt.status === 404 || attempt.status === 405, `unexpected status ${attempt.status}`);
  assert.equal(auth.listAccounts().length, 0);
});

test('a configured admin is seeded on first boot and ignored afterwards', async () => {
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-bootstrap-seed-'));
  const repo = new AuthRepository({ dataDir: seedDir });
  try {
    const seeded = await repo.seedFirstAdmin({ email: 'seed@example.com', password: 'seeded-admin-12345' });
    assert.equal(seeded.email, 'seed@example.com');
    assert.equal(seeded.role, 'admin');
    assert.equal(repo.bootstrapStatus().needed, false, 'seeding closes setup');

    // Leaving the variables in the environment must not create a second admin.
    await assert.rejects(
      () => repo.seedFirstAdmin({ email: 'other@example.com', password: 'other-admin-12345' }),
      /setup is not available/,
    );
    assert.equal(repo.listAccounts().length, 1);
  } finally {
    repo.close();
    fs.rmSync(seedDir, { recursive: true, force: true });
  }
});
