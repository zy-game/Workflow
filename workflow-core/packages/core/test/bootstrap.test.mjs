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

test('a fresh install reports that setup is needed, without a code yet', async () => {
  const status = await call('GET', '/api/v1/auth/bootstrap');
  assert.equal(status.status, 200);
  assert.equal(status.body.needed, true);
  assert.equal(status.body.codeRequired, false, 'no code has been issued yet');
  assert.equal(status.body.activeAccounts, 0);
});

test('setup without an issued code, or with a wrong one, is refused', async () => {
  const noCode = await call('POST', '/api/v1/auth/bootstrap', { email: 'owner@example.com', password: 'first-owner-12345' });
  assert.equal(noCode.status, 400);
  assert.equal(noCode.body.code, 'BOOTSTRAP_CODE_MISSING');

  const { token } = auth.beginBootstrap();
  const wrong = await call('POST', '/api/v1/auth/bootstrap', { code: 'not-the-code', email: 'owner@example.com', password: 'first-owner-12345' });
  assert.equal(wrong.body.code, 'BOOTSTRAP_CODE_INVALID');

  const status = await call('GET', '/api/v1/auth/bootstrap');
  assert.equal(status.body.codeRequired, true, 'a code has now been issued');
  assert.equal(typeof token, 'string');
});

test('the issued code creates the first admin and closes setup for good', async () => {
  const { token } = auth.beginBootstrap();
  const created = await call('POST', '/api/v1/auth/bootstrap', {
    code: token, email: 'owner@example.com', password: 'first-owner-12345',
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.account.email, 'owner@example.com');
  assert.equal(created.body.account.role, 'admin');

  const after = await call('GET', '/api/v1/auth/bootstrap');
  assert.equal(after.body.needed, false);
  assert.equal(after.body.activeAccounts, 1);

  // And it cannot be used again, even with a fresh code attempt.
  assert.throws(() => auth.beginBootstrap(), /setup is not available/);
  const again = await call('POST', '/api/v1/auth/bootstrap', {
    code: token, email: 'second@example.com', password: 'second-owner-12345',
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'BOOTSTRAP_UNAVAILABLE');
});
