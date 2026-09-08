// memory-store.test.mjs - the git-backed memory repository. Memory must be
// readable, editable and rollback-able by the user, so the store is files plus
// git, and every path is confined to the repository root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { MEMORY_LAYOUT, createMemoryStore, resolveInside } from '../src/memory/store.js';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

let dir;
let store;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-memory-'));
  store = createMemoryStore({ root: path.join(dir, 'memory') });
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the layout is created once and is idempotent', { skip: !hasGit }, () => {
  store.ensureLayout();
  for (const entry of [MEMORY_LAYOUT.index, MEMORY_LAYOUT.profile, MEMORY_LAYOUT.projects, MEMORY_LAYOUT.channels, MEMORY_LAYOUT.journal]) {
    assert.ok(fs.existsSync(path.join(store.root, entry)), `missing ${entry}`);
  }
  assert.ok(store.isRepo());
  assert.match(store.read(MEMORY_LAYOUT.index), /Workflow 记忆索引/);

  // A second call must not throw and must not duplicate anything.
  const before = fs.readdirSync(store.root).sort();
  store.ensureLayout();
  assert.deepEqual(fs.readdirSync(store.root).sort(), before);
});

test('write, read and append behave as a file store', { skip: !hasGit }, () => {
  store.write('profile/preferences.md', '# 偏好\n');
  assert.equal(store.read('profile/preferences.md'), '# 偏好\n');
  store.append('profile/preferences.md', '- 工作群不自动回复\n');
  assert.match(store.read('profile/preferences.md'), /工作群不自动回复/);
  assert.equal(store.read('profile/missing.md'), null);
  assert.ok(store.list('profile').some((entry) => entry.name === 'preferences.md'));
});

test('paths outside the repository are rejected', () => {
  for (const bad of ['../escape.md', 'a/../../escape.md', '/etc/passwd', 'C:\\Windows\\system32\\x', '  ']) {
    assert.throws(() => resolveInside(store.root, bad), /memory path|a relative path is required/);
  }
  assert.throws(() => store.write('../escape.md', 'nope'), /memory path/);
});

test('commit is a no-op when nothing changed and returns a hash otherwise', { skip: !hasGit }, () => {
  store.write('journal/2026-09.md', '## 09-08\n');
  const first = store.commit('记忆仓库初始化');
  assert.match(first, /^[0-9a-f]{40}$/);
  assert.equal(store.commit('无变化'), null);

  store.append('journal/2026-09.md', '- 项目 A 登录功能完成\n');
  const second = store.commit('追加观察');
  assert.match(second, /^[0-9a-f]{40}$/);
  assert.notEqual(second, first);
});

test('history and readAt make any memory version recoverable', { skip: !hasGit }, () => {
  const entries = store.history('journal/2026-09.md');
  assert.ok(entries.length >= 2);
  assert.equal(entries[0].subject, '追加观察');
  assert.equal(entries[1].subject, '记忆仓库初始化');

  const oldest = entries[entries.length - 1];
  assert.equal(store.readAt(oldest.commit, 'journal/2026-09.md'), '## 09-08\n');
  assert.equal(store.readAt(entries[0].commit, 'journal/2026-09.md'), '## 09-08\n- 项目 A 登录功能完成\n');
});
