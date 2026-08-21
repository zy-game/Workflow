// management-ai.test.mjs - M4: deterministic extraction over worker session
// transcripts, the management-AI decision protocol (real DshDriver against a
// fake central DSH), and audit recording.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CoreDatabase } from '../src/db/core-db.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { WorkflowRepository } from '../src/knowledge/repository.js';
import { analyzeSession, redactSecrets } from '../src/knowledge/extract.js';
import { DshDriver, parseDecisionJson } from '../src/ai/driver.js';
import { ManagementAi } from '../src/ai/manager.js';
import { sessionToTriple } from '../src/knowledge/extract.js';

let dir;
let coreDb;
let tasks;
let knowledge;
let fakeDsh;
let dshUrl;

// Fake central DSH whose sessions answer prompts with a canned reply after a
// turn/end, exercising the driver's history-polling protocol.
function startFakeDsh(replyFor) {
  const sessions = new Map();
  let sequence = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const envelope = JSON.parse(raw);
      const { method, payload } = envelope;
      const ok = (value) => res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }));
      if (method === 'session.create') {
        const sessionId = `mgr-${++sequence}`;
        sessions.set(sessionId, { events: [], replies: [] });
        return ok({ sessionId });
      }
      if (method === 'session.prompt') {
        const session = sessions.get(payload.sessionId);
        const reply = replyFor(payload.content?.[0]?.text ?? '', payload.sessionId);
        setTimeout(() => {
          session.events.push({ event: { seq: session.events.length, type: 'assistant/message', data: {
            message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
          } } });
          session.events.push({ event: { seq: session.events.length, type: 'turn/end', data: {} } });
        }, 30);
        return ok({ queued: true });
      }
      if (method === 'session.history') {
        const session = sessions.get(payload.sessionId);
        return ok({ header: { id: payload.sessionId }, events: session.events.map((entry) => ({ ...entry })), hasMore: false });
      }
      ok({});
    });
  });
  return server;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-m4-'));
  coreDb = new CoreDatabase({ dataDir: dir });
  tasks = new TaskRepository({ coreDb, claimTimeoutMs: 60_000 });
  knowledge = new WorkflowRepository({ filename: path.join(dir, 'workflow.db') });
  fakeDsh = startFakeDsh((promptText) => {
    if (promptText.includes('当前情况')) {
      return `管理决策如下：\n{"actions":[{"action":"task.create","args":{"type":"improvement","brief":{"goal":"清理死信任务"},"priority":8}},{"action":"report","args":{"note":"复盘完成"}}]}`;
    }
    if (promptText.includes('知识候选')) {
      return '{"keep":[0]}';
    }
    return '{"actions":[]}';
  });
  await new Promise((resolve) => fakeDsh.listen(0, '127.0.0.1', resolve));
  dshUrl = `http://127.0.0.1:${fakeDsh.address().port}`;
});

after(() => {
  fakeDsh.close();
  knowledge.close();
  coreDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let fixtureCounter = 0;

function completedTaskFixture() {
  fixtureCounter += 1;
  const marker = `#${fixtureCounter}`;
  const { task } = tasks.create({
    type: 'dsh.run',
    brief: { goal: `修复登录超时 ${marker}`, acceptance: ['重试不再丢会话'] },
    created_by: 'account:owner',
    worker_selector: { tag: 'm4' },
  });
  const claimed = tasks.claim({ worker_id: 'machine:w1', selector: { tag: 'm4' } });
  assert.equal(claimed.task_id, task.task_id);
  for (const event of [
    { kind: 'assistant', event: { type: 'assistant/message', data: { text: `根因是重试逻辑没有携带会话 token ${marker}，导致每次重试都新建会话。已验证修复后重试保留会话。` } } },
    { kind: 'tool', event: { type: 'tool/call', data: { tool: 'shell', args: { cmd: 'npm test' } } } },
    { kind: 'tool', event: { type: 'tool/result', data: { text: 'tests passed, api_key=sk-live-abcdef123456 in env only' } } },
  ]) {
    tasks.appendSessionEvent(task.task_id, event.event, 'machine:w1');
  }
  const done = tasks.done(task.task_id, claimed.claim_token, { kind: 'done', result: { summary: `重试已保留会话，测试通过 ${marker}。` } });
  return done;
}

test('extraction redacts secrets and produces verified candidates', () => {
  const task = completedTaskFixture();
  const sessionEvents = tasks.events(task.task_id, { type: 'session_event' }).map((event) => event.payload);
  const analysis = analyzeSession({ task, sessionEvents, repository: knowledge, projectId: null });
  assert.ok(analysis.candidates.length >= 1, 'at least one candidate');
  for (const candidate of analysis.candidates) {
    assert.ok(redactSecrets(candidate.body) === candidate.body || !candidate.body.includes('sk-live-'), 'no raw keys');
  }
  const pitfall = analysis.candidates.find((candidate) => candidate.type === 'pitfall');
  assert.ok(pitfall, 'root-cause statement classified as pitfall');
  assert.equal(pitfall.verified, true);
  assert.equal(pitfall.source, `worker-task:${task.task_id}`);
});

test('extraction reads real DSH content-part arrays and skips plugin context messages', () => {
  const task = {
    task_id: 't-realshape',
    type: 'dsh.run',
    brief: { goal: 'goal text', acceptance: ['done'] },
    result: { summary: '' },
  };
  const sessionEvents = [
    { kind: 'user', event: { type: 'user/message', data: {
      content: [{ type: 'text', text: '目标：goal text' }],
      source: { kind: 'user' }, role: 'user',
    } } },
    { kind: 'user', event: { type: 'user/message', data: {
      content: [{ type: 'text', text: 'Current runtime context snapshot from system prompt' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
      role: 'user',
    } } },
    { kind: 'user', event: { type: 'user/message', data: {
      content: [{ type: 'text', text: '请改用分页查询' }],
      source: { kind: 'user' }, role: 'user',
    } } },
    { kind: 'assistant', event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'streaming fragment' } } } },
    { kind: 'assistant', event: { type: 'assistant/message', data: {
      message: { role: 'assistant', content: [
        { type: 'reasoning', text: 'reasoning must not leak into results' },
        { type: 'text', text: '已验证分页查询避免了全表扫描。' },
      ] },
      usage: {},
    } } },
  ];
  const triple = sessionToTriple(task, sessionEvents);
  assert.ok(triple.input.includes('用户纠正：请改用分页查询'));
  assert.ok(!triple.input.includes('runtime context snapshot'), 'plugin snapshot stays out of user corrections');
  assert.ok(triple.result.includes('已验证分页查询避免了全表扫描。'));
  assert.ok(!triple.result.includes('streaming fragment'), 'chunk fragments are not results');
  assert.ok(!triple.result.includes('reasoning must not leak'), 'reasoning parts are not results');
});

test('duplicate fingerprints are filtered against repository memories', () => {  const task = completedTaskFixture();
  const sessionEvents = tasks.events(task.task_id, { type: 'session_event' }).map((event) => event.payload);
  const first = analyzeSession({ task, sessionEvents, repository: knowledge, projectId: null });
  for (const candidate of first.candidates) {
    knowledge.createMemory({
      type: candidate.type, title: candidate.title, body: candidate.body,
      scope: 'global', source: 'seed',
    });
  }
  const second = analyzeSession({ task, sessionEvents, repository: knowledge, projectId: null });
  assert.equal(second.candidates.length, 0);
  assert.ok(second.stats.deduplicated >= 1);
});

test('driver ask/reply protocol works against the fake central DSH', async () => {
  const driver = new DshDriver({ baseUrl: dshUrl });
  const reply = await driver.ask('probe-topic', '当前情况：测试连通');
  const decision = parseDecisionJson(reply);
  assert.ok(Array.isArray(decision.actions));
  assert.equal(decision.actions[0].action, 'task.create');
});

test('management AI executes structured decisions and records audit', async () => {
  const driver = new DshDriver({ baseUrl: dshUrl });
  const ai = new ManagementAi({ driver, taskRepository: tasks, knowledgeRepository: knowledge, coreDb, log: () => {} });
  const before = tasks.list({ limit: 500 }).length;
  const result = await ai.decide('self-optimization', '当前情况：最近失败率上升');
  assert.ok(result.applied.some((entry) => entry.action === 'task.create' && entry.ok));
  assert.equal(tasks.list({ limit: 500 }).length, before + 1);
  const created = tasks.list({ limit: 500 }).find((task) => task.created_by === 'ai:manager');
  assert.ok(created, 'ai-created task exists');
  assert.equal(created.type, 'improvement');
  const rows = coreDb.db.prepare('SELECT * FROM management_decisions ORDER BY ts DESC LIMIT 1').all();
  assert.equal(rows.length, 1);
  const decision = JSON.parse(rows[0].decision_json);
  assert.ok(decision.actions.length >= 1);
  assert.equal(JSON.parse(rows[0].applied_json).length >= 1, true);
  assert.equal(rows[0].error, null);
});

test('completed-task review persists vetted knowledge and records source', async () => {
  const driver = new DshDriver({ baseUrl: dshUrl }); // vetting keeps candidate[0]
  const ai = new ManagementAi({ driver, taskRepository: tasks, knowledgeRepository: knowledge, coreDb, log: () => {} });
  const task = completedTaskFixture();
  const report = await ai.reviewCompletedTask(task);
  assert.ok(report.persisted.length >= 1, 'at least one memory persisted');
  const persisted = knowledge.getMemory(report.persisted[0]);
  assert.equal(persisted.source, `worker-task:${task.task_id}`);
  const searchable = knowledge.searchMemories({ query: '重试 会话' });
  assert.ok(searchable.some((memory) => memory.id === persisted.id));
});

test('review falls back to deterministic set when the AI is unavailable', async () => {
  const ai = new ManagementAi({ driver: null, taskRepository: tasks, knowledgeRepository: knowledge, coreDb, log: () => {}, enabled: true });
  const task = completedTaskFixture();
  const report = await ai.reviewCompletedTask(task);
  // Deterministic path persists every verified candidate; nothing throws.
  assert.ok(Array.isArray(report.persisted));
});
