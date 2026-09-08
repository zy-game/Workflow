// presence.test.mjs - where the user is, as reported by the touchpoints. The
// server derives the answer from facts instead of guessing, so a stale client
// cannot claim presence it does not have.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { PresenceRepository, createPresenceService } from '../src/presence/service.js';
import { TaskRepository } from '../src/tasks/repository.js';

let dir;
let auth;
let coreDb;
let repository;
let presence;
let server;
let base;
let token;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-presence-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDb = new CoreDatabase({ dataDir: dir });
  repository = new PresenceRepository({ coreDb });
  presence = createPresenceService({ presenceRepository: repository, ttlMs: 60_000 });
  token = auth.createMachineToken({ subject_id: 'presence-admin', role: 'admin' }).token;
});

after(() => {
  server?.close();
  coreDb.close();
  auth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a reported touchpoint is online and can be replaced in place', () => {
  presence.report({ touchpoint_id: 'tp-1', kind: 'browser', idle_bucket: 'active' });
  assert.deepEqual(presence.online().map((entry) => entry.touchpointId), ['tp-1']);

  presence.report({ touchpoint_id: 'tp-1', kind: 'browser', idle_bucket: 'idle', active_project: 'proj-a' });
  const [entry] = presence.online();
  assert.equal(entry.idleBucket, 'idle');
  assert.equal(entry.activeProject, 'proj-a');
  assert.equal(presence.online().length, 1, 'reporting twice must not duplicate a touchpoint');
});

test('a touchpoint that stops reporting expires out of the list', () => {
  const stale = new Date(Date.now() - 5 * 60_000);
  repository.upsert({ touchpointId: 'tp-stale', kind: 'desktop', idleBucket: 'active', ttlMs: 60_000, now: stale });
  // Already past its TTL, so a read must not surface it...
  assert.ok(!presence.online().some((entry) => entry.touchpointId === 'tp-stale'));
  // ...and the lazy purge has already removed the row.
  assert.equal(repository.purge(new Date()), 0);
});

test('the active touchpoint is the loudest, ties broken by recency', () => {
  repository.purge(new Date());
  presence.report({ touchpoint_id: 'tp-idle', kind: 'desktop', idle_bucket: 'idle' });
  presence.report({ touchpoint_id: 'tp-active', kind: 'browser', idle_bucket: 'active' });
  presence.report({ touchpoint_id: 'tp-recent', kind: 'phone', idle_bucket: 'recent' });
  assert.equal(presence.active().touchpointId, 'tp-active');

  presence.report({ touchpoint_id: 'tp-active', kind: 'browser', idle_bucket: 'idle' });
  presence.report({ touchpoint_id: 'tp-idle', kind: 'desktop', idle_bucket: 'active' });
  assert.equal(presence.active().touchpointId, 'tp-idle');
});

test('the first acknowledgement wins and suppresses the others', () => {
  const first = presence.ack({ notificationId: 'note-1', touchpointId: 'tp-active' });
  assert.equal(first.touchpointId, 'tp-active');
  const second = presence.ack({ notificationId: 'note-1', touchpointId: 'tp-recent' });
  assert.equal(second.touchpointId, 'tp-active', 'a later ack must not steal the notification');
  assert.equal(presence.ackedBy('note-1'), 'tp-active');
  assert.equal(presence.ackedBy('note-unknown'), null);
});

test('malformed reports are refused', () => {
  assert.throws(() => presence.report({ kind: 'browser' }), /touchpoint_id is required/);
  assert.throws(() => presence.report({ touchpoint_id: 'tp-x', kind: 'toaster' }), /unsupported touchpoint kind/);
  assert.throws(() => presence.ack({ notificationId: 'note-1' }), /required/);
});

test('presence is reachable over HTTP', async () => {
  const app = createCoreServer({
    config: {}, authRepository: auth, taskRepository: new TaskRepository({ coreDb }), presenceService: presence,
  });
  server = await app.listen({ host: '127.0.0.1', port: 0, tls: null });
  base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const reported = await call('POST', '/api/v1/presence', { touchpoint_id: 'tp-http', kind: 'browser', idle_bucket: 'active' });
  assert.equal(reported.status, 200);

  const listed = await call('GET', '/api/v1/presence');
  assert.ok(listed.body.online.some((entry) => entry.touchpointId === 'tp-http'));
  assert.equal(listed.body.active.touchpointId, 'tp-http');
  assert.equal(listed.body.ttl_ms, 60_000);

  const acked = await call('POST', '/api/v1/presence/note-http/ack', { touchpoint_id: 'tp-http' });
  assert.equal(acked.body.acked_by, 'tp-http');

  const anonymous = await fetch(`${base}/api/v1/presence`);
  assert.equal(anonymous.status, 401);
});
