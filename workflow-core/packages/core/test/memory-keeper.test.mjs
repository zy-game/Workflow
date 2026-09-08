// memory-keeper.test.mjs - the bounded memory maintenance loop. It records
// only what the model asks it to, only inside the repository, and a failure
// leaves the previous memory intact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { createMemoryKeeper, loadMemorySkill, parseWritePlan } from '../src/memory/keeper.js';
import { createMemoryStore } from '../src/memory/store.js';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

let dir;
let store;

function fakeLlm(reply, enabled = true) {
  const calls = [];
  return {
    calls,
    status: { enabled },
    ask: async (messages) => { calls.push(messages); return reply; },
  };
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-keeper-'));
  store = createMemoryStore({ root: path.join(dir, 'memory') });
  store.ensureLayout();
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the write plan tolerates prose and rejects anything malformed', () => {
  assert.deepEqual(
    parseWritePlan('```json\n[{"op":"append","path":"journal/2026-09.md","text":"- x\\n"}]\n```')
      .map((entry) => entry.path),
    ['journal/2026-09.md'],
  );
  assert.deepEqual(parseWritePlan('没有要记的'), []);
  assert.deepEqual(parseWritePlan('[{broken json'), []);
  assert.deepEqual(parseWritePlan('[{"op":"delete","path":"x.md"},{"op":"write","path":""}]'), []);
  assert.equal(parseWritePlan(JSON.stringify(Array.from({ length: 50 }, () => ({ op: 'append', path: 'a.md', text: 'x' })))).length, 20);
});

test('the skill file is shipped and describes the write contract', () => {
  const skill = loadMemorySkill();
  assert.ok(skill, 'workflow-memory skill must ship with Core');
  assert.match(skill, /只追加，不覆盖/);
  assert.match(skill, /凭据、token/);
  assert.match(skill, /"op": "append"/);
});

test('the keeper applies the plan and commits it', { skip: !hasGit }, async () => {
  const llm = fakeLlm(JSON.stringify([
    { op: 'append', path: 'journal/2026-09.md', text: '- 2026-09-08 项目 A 登录功能完成\n' },
    { op: 'write', path: 'projects/proj-a/context.md', content: '# 项目 A\n\n已完成登录功能。\n' },
  ]));
  const keeper = createMemoryKeeper({ memoryStore: store, serverLlm: llm, digest: async () => ({ projects: ['proj-a'] }) });
  const result = await keeper.runOnce();
  assert.equal(result.changed, true);
  assert.equal(result.applied, 2);
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  assert.match(store.read('journal/2026-09.md'), /登录功能完成/);
  assert.match(store.read('projects/proj-a/context.md'), /已完成登录功能/);
  // The skill is what the model is told to follow.
  assert.match(llm.calls[0][0].content, /Workflow 记忆维护/);
});

test('a write that escapes the repository is dropped, not written', { skip: !hasGit }, async () => {
  const llm = fakeLlm(JSON.stringify([
    { op: 'write', path: '../outside.md', content: 'nope' },
    { op: 'append', path: 'journal/2026-09.md', text: '- 合法的一条\n' },
  ]));
  const keeper = createMemoryKeeper({ memoryStore: store, serverLlm: llm, digest: async () => ({ any: true }) });
  const result = await keeper.runOnce();
  assert.equal(result.applied, 1);
  assert.equal(fs.existsSync(path.join(dir, 'outside.md')), false);
});

test('the keeper stays out of the way when it cannot run', async () => {
  const noLlm = createMemoryKeeper({ memoryStore: store, serverLlm: fakeLlm('[]', false), digest: async () => ({ any: true }) });
  assert.deepEqual(await noLlm.runOnce(), { changed: false, reason: 'llm_disabled' });

  const noDigest = createMemoryKeeper({ memoryStore: store, serverLlm: fakeLlm('[]'), digest: async () => null });
  assert.deepEqual(await noDigest.runOnce(), { changed: false, reason: 'nothing_to_record' });

  const brokenDigest = createMemoryKeeper({ memoryStore: store, serverLlm: fakeLlm('[]'), digest: async () => { throw new Error('boom'); } });
  assert.deepEqual(await brokenDigest.runOnce(), { changed: false, reason: 'digest_failed' });

  const emptyPlan = createMemoryKeeper({ memoryStore: store, serverLlm: fakeLlm('[]'), digest: async () => ({ any: true }) });
  assert.deepEqual(await emptyPlan.runOnce(), { changed: false, reason: 'no_writes' });
});
