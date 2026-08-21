import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WorkflowRepository, RevisionConflictError } from '../src/knowledge/repository.js';

let dir;
let repo;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-know-'));
  repo = new WorkflowRepository({ filename: path.join(dir, 'workflow.db') });
});

after(() => {
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolves projects by machine/path with aliases, creating on demand', () => {
  const project = repo.resolveProject({ path: 'E:\\Workflow\\App\\', machine: 'WIN-DEV' });
  assert.equal(project.name, 'App');
  const again = repo.resolveProject({ path: 'e:/workflow/app', machine: 'win-dev' });
  assert.equal(again.id, project.id);
  repo.addProjectLocation(project.id, { path: 'E:/ aliases check', machine: 'other' });
  const posix = repo.resolveProject({ path: '/home/ubuntu/workspaces/default', machine: 'linux-box' });
  assert.notEqual(posix.id, project.id);
  const missing = repo.resolveProject({ path: '/nowhere', machine: 'linux-box', create: false });
  assert.equal(missing, null);
});

test('memories round-trip with tags, FTS search in both languages, and revision conflicts', () => {
  const project = repo.resolveProject({ path: 'E:\\Workflow\\App', machine: 'WIN-DEV' });
  const created = repo.createMemory({
    type: 'pitfall', title: 'Windows path casing', body: '路径大小写导致 SQLite 打不开；必须统一小写归一化。api_key=sk-live-should-not-appear',
    projectId: project.id, tags: ['windows', 'sqlite'], keywords: ['path'],
  });
  assert.equal(created.scope, 'project');
  assert.equal(created.revision > 0, true);

  const english = repo.createMemory({
    type: 'decision', title: 'SQLite over JSON files', body: 'Decided SQLite because restart persistence matters for authority data.',
    scope: 'global',
  });

  // unicode61 does not segment CJK; a query must match a token prefix.
  const byChinese = repo.searchMemories({ query: '路径' });
  assert.ok(byChinese.some((memory) => memory.id === created.id));
  const byEnglish = repo.searchMemories({ query: 'restart persistence' });
  assert.ok(byEnglish.some((memory) => memory.id === english.id));

  assert.throws(() => repo.updateMemory(created.id, { body: 'updated' }, { expectedRevision: created.revision + 5 }), RevisionConflictError);
  const conflicts = repo.listConflicts();
  assert.equal(conflicts.length, 1);
  const updated = repo.updateMemory(created.id, { body: 'updated body' }, { expectedRevision: created.revision });
  assert.equal(updated.revision > created.revision, true);
});

test('context assembles attention + memories within budget and sanitizes secret lines', () => {
  const project = repo.resolveProject({ path: 'E:\\Workflow\\App', machine: 'WIN-DEV' });
  repo.createDocument({ kind: 'attention', slug: 'coding', title: 'Coding', body: 'Line one\npassword: hunter2hunter2\nLine two', projectId: project.id });
  const context = repo.getContext({ projectId: project.id, maxChars: 400 });
  assert.ok(context.context_text.includes('Project attention'));
  assert.ok(!context.context_text.includes('hunter2hunter2'));
  assert.ok(context.used_chars <= 400);
  assert.ok(context.totals.projectAttention >= 1);
});

test('sync changes expose a monotonic cursor', () => {
  const before = repo.currentRevision();
  repo.createMemory({ type: 'insight', title: 'cursor insight', body: 'cursors move forward', scope: 'global' });
  const page = repo.listChanges({ cursor: before });
  assert.ok(page.changes.length >= 1);
  assert.ok(page.nextCursor > before);
});
