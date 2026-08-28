import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CoreDatabase } from '../src/db/core-db.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { ServerLlm } from '../src/ai/server-llm.js';
import { WorkflowRepository } from '../src/knowledge/repository.js';

let dir;
let coreDb;
let tasks;
let knowledge;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-llm-'));
  coreDb = new CoreDatabase({ dataDir: dir });
  tasks = new TaskRepository({ coreDb, claimTimeoutMs: 60_000 });
});

after(() => {
  try { knowledge?.close(); } catch { /* already closed */ }
  try { coreDb.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked file */ }
});

function fakeFetch(result) {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content: result } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('server llm distills a finished session into knowledge entries', async () => {
  knowledge = new WorkflowRepository({ filename: path.join(dir, 'workflow.db'), readOnly: false });
  knowledge.resolveProject({ projectId: 'proj-x', path: '/tmp/proj-x', create: true });
  const created = tasks.create({
    type: 'workflow.run', project_id: 'proj-x', brief: { goal: 'build a parser' },
    created_by: 'account:test',
  });
  const task = created.task ?? created;
  const claimed = tasks.claim({ worker_id: 'win-test', selector: {}, project_ids: ['proj-x'], capabilities: [], backends: [{ kind: 'workflow-jsonl', capabilities: ['run'] }] });
  assert.equal(claimed?.task_id ?? claimed?.task?.task_id, task.task_id);
  tasks.appendSessionEvent(task.task_id, { type: 'assistant_chunk', text: 'steps…' }, 'win-test');
  const claimToken = tasks.get(task.task_id).claim_token;
  tasks.done(task.task_id, claimToken, { kind: 'done', result: { text: 'parser built' } });

  const llm = new ServerLlm({
    enabled: true, baseUrl: 'http://localhost/v1', apiKey: 'k', model: 'm', log: () => {},
    fetchImpl: fakeFetch('[{"title":"Parser should ignore comments","type":"insight","content":"a"},{"title":"split by line hits empties","type":"pitfall","content":"b"}]'),
  });
  const result = await llm.distillSession({
    taskRepository: tasks,
    knowledgeRepository: knowledge,
    taskId: task.task_id,
    projectId: 'proj-x',
    taskType: 'workflow.run',
    events: tasks.events(task.task_id),
  });
  assert.equal(result.distilled, 2);
  const memories = knowledge.listMemories({ projectId: 'proj-x' });
  assert.equal(memories.length, 2);
  assert.ok(memories.some((m) => m.type === 'pitfall'));
  const evs = tasks.events(task.task_id);
  assert.ok(evs.some((e) => e.type === 'knowledge_distilled'));
  knowledge.close();
  knowledge = null;
});

test('server llm tolerates failures and never throws', async () => {
  const llm = new ServerLlm({
    enabled: true, baseUrl: 'http://localhost/v1', apiKey: 'k', model: 'm', log: () => {},
    fetchImpl: async () => new Response('boom', { status: 500 }),
  });
  const result = await llm.distillSession({
    taskRepository: tasks,
    knowledgeRepository: null,
    taskId: 't-unknown',
    projectId: null,
    taskType: 'workflow.run',
    events: [],
  });
  assert.equal(result.distilled, 0);
});

test('server llm stays disabled without api key', async () => {
  const llm = new ServerLlm({ enabled: true, baseUrl: 'x', apiKey: null, model: 'm' });
  assert.equal(llm.status.enabled, false);
});
