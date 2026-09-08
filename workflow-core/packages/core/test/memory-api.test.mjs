// memory-api.test.mjs - the console's view of memory: read the files, read the
// history, roll a file back. Every route is admin-only and confined to the
// repository.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { createMemoryStore } from '../src/memory/store.js';
import { TaskRepository } from '../src/tasks/repository.js';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

let dir;
let auth;
let coreDb;
let store;
let server;
let base;
let token;

async function call(method, pathname, body, bearer = token) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-memory-api-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDb = new CoreDatabase({ dataDir: dir });
  store = createMemoryStore({ root: path.join(dir, 'memory') });
  store.ensureLayout();
  store.write('projects/proj-a/context.md', '# 项目 A\n\n初始状态。\n');
  store.commit('seed');
  store.write('projects/proj-a/context.md', '# 项目 A\n\n登录已完成。\n');
  store.commit('update');
  token = auth.createMachineToken({ subject_id: 'memory-admin', role: 'admin' }).token;
  const app = createCoreServer({
    config: {}, authRepository: auth, taskRepository: new TaskRepository({ coreDb }), memoryStore: store,
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

test('the tree, a file and its history are readable', { skip: !hasGit }, async () => {
  const tree = await call('GET', '/api/v1/memory/tree');
  assert.equal(tree.status, 200);
  const projects = tree.body.tree.find((entry) => entry.name === 'projects');
  assert.ok(projects?.children.some((entry) => entry.name === 'proj-a'));

  const file = await call('GET', '/api/v1/memory/file?path=projects/proj-a/context.md');
  assert.equal(file.status, 200);
  assert.match(file.body.content, /登录已完成/);

  const history = await call('GET', '/api/v1/memory/history?path=projects/proj-a/context.md');
  assert.ok(history.body.history.length >= 2);
  assert.equal(history.body.history[0].subject, 'update');
});

test('a path outside the repository is refused, not served', { skip: !hasGit }, async () => {
  const escape = await call('GET', '/api/v1/memory/file?path=../../etc/passwd');
  assert.equal(escape.status, 400);
  assert.match(escape.body.error, /memory path/);

  const missing = await call('GET', '/api/v1/memory/file?path=profile/nope.md');
  assert.equal(missing.status, 404);

  const noPath = await call('GET', '/api/v1/memory/file');
  assert.equal(noPath.status, 400);
});

test('a file can be rolled back, and the rollback is itself a commit', { skip: !hasGit }, async () => {
  const history = await call('GET', '/api/v1/memory/history?path=projects/proj-a/context.md');
  const oldest = history.body.history[history.body.history.length - 1];
  const reverted = await call('POST', '/api/v1/memory/revert', { commit: oldest.commit, path: 'projects/proj-a/context.md' });
  assert.equal(reverted.status, 200);
  assert.match(reverted.body.content, /初始状态/);

  const after = await call('GET', '/api/v1/memory/history?path=projects/proj-a/context.md');
  assert.match(after.body.history[0].subject, /revert/);

  const unknown = await call('POST', '/api/v1/memory/revert', { commit: '0'.repeat(40), path: 'projects/proj-a/context.md' });
  assert.equal(unknown.status, 404);
});

test('memory routes require an admin session', { skip: !hasGit }, async () => {
  const anonymous = await call('GET', '/api/v1/memory/tree', undefined, null);
  assert.equal(anonymous.status, 401);
});
