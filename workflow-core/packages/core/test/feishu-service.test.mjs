// feishu-service.test.mjs - M5: message→task→watch card, throttled live card
// refresh, reply-as-correction injection, cancel button, approval cards, and
// the admin console page. Uses the real repositories; fake Feishu client and
// fake worker channel capture outbound traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CoreDatabase } from '../src/db/core-db.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { FeishuService } from '../src/feishu/service.js';
import { buildTaskCard, latestView } from '../src/feishu/client.js';
import { createCoreServer } from '../src/http/server.js';
import { AuthRepository } from '../src/auth/repository.js';

let dir;
let coreDb;
let tasks;
let sentCards;
let updatedCards;
let frames;
let dispatchCalls;
let service;
let server;
let base;

function fakeClient() {
  let sequence = 0;
  const sent = [];
  const updated = [];
  return {
    sent, updated,
    sendCard: async (chatId, card) => {
      sequence += 1;
      sent.push({ chatId, card });
      return { message_id: `fm-${sequence}` };
    },
    updateCard: async (messageId, card) => {
      updated.push({ messageId, card });
      return { ok: true };
    },
  };
}

function fakeChannel() {
  const frames = [];
  let dispatches = 0;
  return {
    frames,
    get dispatches() { return dispatches; },
    tryDispatch: () => { dispatches += 1; return 1; },
    sendToWorker: (workerId, frameValue) => {
      frames.push({ workerId, frame: frameValue });
      return true;
    },
  };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-m5-'));
  coreDb = new CoreDatabase({ dataDir: dir });
  tasks = new TaskRepository({ coreDb, claimTimeoutMs: 60_000 });
  const client = fakeClient();
  sentCards = client.sent;
  updatedCards = client.updated;
  const channel = fakeChannel();
  frames = channel.frames;
  dispatchCalls = () => channel.dispatches;
  service = new FeishuService({ client, taskRepository: tasks, workerChannel: channel, coreDb, log: () => {} });

  // A small server instance just for the console page + webhook route checks.
  const auth = new AuthRepository({ dataDir: dir });
  const core = createCoreServer({
    config: { feishu: { callbacksEnabled: true, verificationToken: 'test-verification-token' } },
    authRepository: auth,
    taskRepository: tasks,
    feishuService: service,
  });
  server = await core.listen({ host: '127.0.0.1', port: 0, tls: null, surface: 'public' });
  base = `http://127.0.0.1:${server.address().port}`;
  auth.close();
});

after(() => {
  service.stop();
  server.close();
  coreDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function activeTask(tag = 'm5') {
  const { task } = tasks.create({
    type: 'dsh.run', brief: { goal: '被观察的任务' },
    created_by: 'account:owner', worker_selector: { tag },
  });
  return { task, claimed: tasks.claim({ worker_id: 'machine:w1', selector: { tag } }) };
}

test('inbound message creates a watched task and sends a live card', async () => {
  const result = await service.handleInboundMessage({ messageId: 'om-1', chatId: 'oc-main', text: '帮我把构建脚本修好' });
  assert.equal(result.ok, true);
  const task = tasks.get(result.task_id);
  assert.equal(task.type, 'feishu.message');
  assert.match(task.brief.goal, /构建脚本/);
  assert.equal(sentCards.length, 1);
  assert.equal(sentCards[0].chatId, 'oc-main');
  assert.ok(JSON.stringify(sentCards[0].card).includes('排队中'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatchCalls(), 1, 'new Feishu task triggers dispatch to an online worker');

  const duplicate = await service.handleInboundMessage({ messageId: 'om-1', chatId: 'oc-main', text: '帮我把构建脚本修好' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(sentCards.length, 1);
});

test('session events refresh the watch card with current tool and output', async () => {
  const { claimed } = activeTask();
  const watch = coreDb.db.prepare('SELECT * FROM watch_subscriptions WHERE task_id = ?').get(claimed.task_id);
  if (!watch) {
    // Attach a watch to this manually created task by sending one inbound
    // message flow: instead reuse the subscription API directly.
    const card = await service.client.sendCard('oc-main', buildTaskCard({ task: claimed }));
    coreDb.db.prepare('INSERT INTO watch_subscriptions(id, task_id, chat_id, message_id, last_card_at, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(`ws-test-${claimed.task_id}`, claimed.task_id, 'oc-main', card.message_id, new Date().toISOString(), new Date().toISOString());
  }
  tasks.appendSessionEvent(claimed.task_id, { type: 'assistant/message', data: { text: '正在定位构建失败原因' } });
  tasks.appendSessionEvent(claimed.task_id, { type: 'tool/call', data: { tool: 'shell', args: { cmd: 'npm run build' } } });
  tasks.progress(claimed.task_id, claimed.claim_token, { note: 'working' });
  await new Promise((resolve) => setTimeout(resolve, 3400)); // throttle window
  const last = updatedCards.at(-1);
  assert.ok(last, 'card was updated');
  const rendered = JSON.stringify(last.card);
  assert.ok(rendered.includes('npm run build'), 'current tool rendered');
  assert.ok(rendered.includes('正在定位构建失败原因'), 'assistant excerpt rendered');
});

test('reply in the watched chat injects into the running session, not a new task', async () => {
  const before = tasks.list({ limit: 500 }).length;
  const { claimed } = activeTask('m5-inject');
  coreDb.db.prepare('INSERT INTO watch_subscriptions(id, task_id, chat_id, message_id, last_card_at, active, created_at) VALUES (?,?,?,?,?,1,?)')
    .run(`ws-inj-${claimed.task_id}`, claimed.task_id, 'oc-main', 'fm-x', new Date().toISOString(), new Date().toISOString());
  const result = await service.handleInboundMessage({ messageId: 'om-inj', chatId: 'oc-main', text: '别重构了，直接跑测试', senderId: 'ou-user' });
  assert.equal(result.injected, true);
  assert.equal(result.task_id, claimed.task_id);
  assert.equal(tasks.list({ limit: 500 }).length, before + 1); // only the manual task
  const injectFrame = frames.find((entry) => entry.frame.type === 'inject');
  assert.ok(injectFrame, 'inject frame delivered to worker');
  assert.match(injectFrame.frame.payload.content, /直接跑测试/);
  const injectedEvents = tasks.events(claimed.task_id).filter((event) => event.type === 'injected');
  assert.equal(injectedEvents.length, 1);
});

test('bare approve/deny replies decide a pending approval instead of injecting', async () => {
  const { claimed } = activeTask('m5-appr-reply');
  coreDb.db.prepare('INSERT INTO watch_subscriptions(id, task_id, chat_id, message_id, last_card_at, active, created_at) VALUES (?,?,?,?,?,1,?)')
    .run(`ws-aprr-${claimed.task_id}`, claimed.task_id, 'oc-main', 'fm-y', new Date().toISOString(), new Date().toISOString());
  const { approval_id: approvalId } = await service.handleApprovalRequest({
    task_id: claimed.task_id, tool: 'shell:rm', reason: '删除构建目录',
    dsh_approval_id: 'dsh-ap-9', dsh_rpc_id: 'rpc-9', dsh_session_id: 'sess-9',
  });

  const approved = await service.handleInboundMessage({ messageId: 'om-appr-a', chatId: 'oc-main', text: '批准', senderId: 'ou-user' });
  assert.equal(approved.approval_resolved, true);
  assert.equal(approved.approved, true);
  const status = coreDb.db.prepare('SELECT status FROM pending_approvals WHERE approval_id = ?').get(approvalId);
  assert.equal(status.status, 'approved');
  const frame = frames.find((entry) => entry.frame.type === 'approval_result');
  assert.ok(frame, 'approval_result delivered to worker');
  assert.equal(frame.frame.payload.dsh_approval_id, 'dsh-ap-9');
  assert.equal(frame.frame.payload.dsh_rpc_id, 'rpc-9');
  const injectFrames = frames.filter((entry) => entry.frame.type === 'inject' && entry.frame.payload.task_id === claimed.task_id);
  assert.equal(injectFrames.length, 0, 'keyword reply did not inject');

  // A second approval is denied the same way; other prose still injects.
  const second = await service.handleApprovalRequest({ task_id: claimed.task_id, tool: 'fs:write' });
  const denied = await service.handleInboundMessage({ messageId: 'om-appr-b', chatId: 'oc-main', text: '拒绝。', senderId: 'ou-user' });
  assert.equal(denied.approved, false);
  assert.equal(coreDb.db.prepare('SELECT status FROM pending_approvals WHERE approval_id = ?').get(second.approval_id).status, 'denied');
  const prose = await service.handleInboundMessage({ messageId: 'om-appr-c', chatId: 'oc-main', text: '顺便看下日志', senderId: 'ou-user' });
  assert.equal(prose.injected, true);
});

test('cancel button cancels the task and notifies the worker', async () => {
  const { claimed } = activeTask('m5-cancel');
  const result = await service.handleCardAction({ kind: 'cancel', task_id: claimed.task_id });
  assert.equal(result.ok, true);
  assert.equal(tasks.get(claimed.task_id).status, 'cancelled');
  const cancelFrame = frames.find((entry) => entry.frame.type === 'cancel' && entry.frame.payload.task_id === claimed.task_id);
  assert.ok(cancelFrame, 'cancel frame delivered');
});

test('approval request becomes an approve/deny card and resolves back to the worker', async () => {
  const { claimed } = activeTask('m5-appr');
  coreDb.db.prepare('INSERT INTO watch_subscriptions(id, task_id, chat_id, message_id, last_card_at, active, created_at) VALUES (?,?,?,?,?,1,?)')
    .run(`ws-appr-${claimed.task_id}`, claimed.task_id, 'oc-main', 'fm-appr', new Date().toISOString(), new Date().toISOString());
  const { approval_id: approvalId } = await service.handleApprovalRequest({
    task_id: claimed.task_id, tool: 'shell:rm', risk: 'high', reason: '删除 build 目录',
  });
  const pending = coreDb.db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId);
  assert.equal(pending.status, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 100)); // immediate refresh
  const cardWithApproval = updatedCards.map((entry) => JSON.stringify(entry.card)).find((rendered) => rendered.includes('待审批'));
  assert.ok(cardWithApproval, 'approval rendered into card');
  assert.ok(cardWithApproval.includes('批准') && cardWithApproval.includes('拒绝'));

  const approved = await service.handleCardAction({ kind: 'approve', approval_id: approvalId, task_id: claimed.task_id });
  assert.equal(approved.ok, true);
  assert.equal(approved.approved, true);
  const resultFrame = frames.find((entry) => entry.frame.type === 'approval_result');
  assert.ok(resultFrame, 'approval_result delivered to worker');
  assert.equal(resultFrame.frame.payload.approved, true);
  const resolved = coreDb.db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId);
  assert.equal(resolved.status, 'approved');
  const deniedAgain = await service.handleCardAction({ kind: 'approve', approval_id: approvalId, task_id: claimed.task_id });
  assert.equal(deniedAgain.ok, false);
});

test('card builders classify events and gate buttons by status', () => {
  const view = latestView([
    { payload: { event: { type: 'assistant/message', data: { text: '结论' } } } },
    { payload: { event: { type: 'tool/call', data: { tool: 'shell' } } } },
    { payload: { event: { type: 'tool/call', data: { tool: 'fs' } } } },
  ]);
  assert.equal(view.currentTool, 'shell');
  assert.equal(view.toolCount, 2);
  const running = buildTaskCard({ task: { task_id: 't-x', type: 'dsh.run', status: 'running', priority: 3, attempts: 1, max_attempts: 3, brief: { goal: 'g' } } });
  assert.ok(JSON.stringify(running).includes('取消任务'));
  const done = buildTaskCard({ task: { task_id: 't-x', type: 'dsh.run', status: 'done', priority: 3, attempts: 1, max_attempts: 3, brief: { goal: 'g' }, result: { summary: 'ok' } } });
  assert.ok(!JSON.stringify(done).includes('取消任务'));
});

test('admin console page and feishu webhook route are served', async () => {
  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('Workflow Core'));
  assert.ok(html.includes("document.querySelectorAll('form input,form textarea,form select')"));
  assert.ok(html.includes('finally{restoreDraft(draft)}'));
  assert.ok(html.includes('@media(max-width:640px)'));
  assert.ok(html.includes('table{display:block;max-width:100%;overflow-x:auto;white-space:nowrap}'));
  assert.ok(html.includes("var draft=$('#injectText')?$('#injectText').value:''"));
  assert.ok(html.includes("if(active&&draft&&$('#injectText'))$('#injectText').value=draft"));

  const rejected = await fetch(`${base}/webhook/feishu`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: 'abc-123' }),
  });
  assert.equal(rejected.status, 401);

  const challenge = await fetch(`${base}/webhook/feishu`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'test-verification-token', challenge: 'abc-123' }),
  });
  assert.equal((await challenge.json()).challenge, 'abc-123');

  const { claimed } = activeTask('m5-hook');
  const action = await fetch(`${base}/webhook/feishu`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: 'test-verification-token',
      action: { value: { kind: 'cancel', task_id: claimed.task_id } },
    }),
  });
  assert.equal((await action.json()).ok, true);
  assert.equal(tasks.get(claimed.task_id).status, 'cancelled');
});
