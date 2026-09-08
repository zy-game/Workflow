// proposals.test.mjs - decisions waiting on the user. The veto window means
// "act unless the user objects": a pending proposal past its deadline is
// approved by timeout, while an explicit rejection always wins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { ProposalRepository } from '../src/proposals/repository.js';
import { createProposalService } from '../src/proposals/service.js';
import { TaskRepository } from '../src/tasks/repository.js';

let dir;
let auth;
let coreDb;
let proposals;
let server;
let base;
let token;

async function call(pathname, { method = 'POST', body = {}, bearer = token } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-proposals-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDb = new CoreDatabase({ dataDir: dir });
  proposals = createProposalService({ proposalRepository: new ProposalRepository({ coreDb }) });
  token = auth.createMachineToken({ subject_id: 'prop-admin', role: 'admin' }).token;
  const app = createCoreServer({
    config: {}, authRepository: auth, taskRepository: new TaskRepository({ coreDb }),
    proposalService: proposals,
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

function draft(overrides = {}) {
  return {
    proposal_id: 'prop-1',
    source_type: 'probe',
    source_ref: 'probe-1',
    channel_target: 'feishu:chat:oc_123',
    title: '项目 A：登录功能状态回复',
    ask: '群里有人问"登录做好了没"。执行器查证已完成。是否以此回复？',
    options: ['立即回复', '改为私聊确认', '否决'],
    draft_text: '已完成，版本 v1.4.2',
    evidence: [{ kind: 'commit', ref: 'a41f9c2' }],
    veto_ms: 30000,
    ...overrides,
  };
}

test('a proposal opens pending and re-requesting its id is idempotent', async () => {
  const created = await call('/api/v1/proposals', { body: draft() });
  assert.equal(created.status, 200);
  assert.equal(created.body.created, true);
  assert.equal(created.body.proposal.state, 'pending');
  assert.equal(created.body.proposal.decision, null);
  assert.ok(created.body.proposal.vetoDeadline);

  const again = await call('/api/v1/proposals', { body: draft({ title: '不同标题' }) });
  assert.equal(again.body.created, false);
  assert.equal(again.body.proposal.title, '项目 A：登录功能状态回复');
});

test('the user can approve or reject once, and a second decision is refused', async () => {
  await call('/api/v1/proposals', { body: draft({ proposal_id: 'prop-approve' }) });
  const approved = await call('/api/v1/proposals/prop-approve/approve', { body: {} });
  assert.equal(approved.body.proposal.state, 'approved');
  assert.equal(approved.body.proposal.decision, 'user');
  const twice = await call('/api/v1/proposals/prop-approve/approve', { body: {} });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, 'PROPOSAL_NOT_OPEN');

  await call('/api/v1/proposals', { body: draft({ proposal_id: 'prop-reject' }) });
  const rejected = await call('/api/v1/proposals/prop-reject/reject', { body: {} });
  assert.equal(rejected.body.proposal.state, 'rejected');
  assert.equal(rejected.body.proposal.decision, 'user');
});

test('a pending proposal past its deadline is approved by timeout', async () => {
  await call('/api/v1/proposals', { body: draft({ proposal_id: 'prop-timeout', veto_ms: 0 }) });
  const due = proposals.expireDue();
  assert.equal(due.length, 1);
  assert.equal(due[0].proposalId, 'prop-timeout');
  assert.equal(due[0].state, 'approved');
  assert.equal(due[0].decision, 'timeout');
  // Sweeping again must not re-resolve it.
  assert.equal(proposals.expireDue().length, 0);
});

test('a proposal without a veto window never expires on its own', async () => {
  await call('/api/v1/proposals', { body: draft({ proposal_id: 'prop-nowindow', veto_ms: null }) });
  assert.equal(proposals.expireDue().length, 0);
  const read = await call('/api/v1/proposals/prop-nowindow', { method: 'GET' });
  assert.equal(read.body.proposal.state, 'pending');
  assert.equal(read.body.proposal.vetoDeadline, null);
});

test('malformed proposals and unknown ids are rejected', async () => {
  const noTitle = await call('/api/v1/proposals', { body: draft({ proposal_id: 'p-x', title: '  ' }) });
  assert.equal(noTitle.status, 400);
  assert.equal(noTitle.body.code, 'title_required');

  const noAsk = await call('/api/v1/proposals', { body: draft({ proposal_id: 'p-y', ask: '' }) });
  assert.equal(noAsk.body.code, 'ask_required');

  const badVeto = await call('/api/v1/proposals', { body: draft({ proposal_id: 'p-z', veto_ms: -1 }) });
  assert.equal(badVeto.body.code, 'veto_ms_invalid');

  const missing = await call('/api/v1/proposals/does-not-exist', { method: 'GET' });
  assert.equal(missing.status, 404);

  const anonymous = await call('/api/v1/proposals', { body: draft({ proposal_id: 'p-anon' }), bearer: null });
  assert.equal(anonymous.status, 401);
});

test('proposals can be listed by state', async () => {
  const pending = await call('/api/v1/proposals?state=pending', { method: 'GET' });
  assert.ok(pending.body.proposals.every((proposal) => proposal.state === 'pending'));
  const approved = await call('/api/v1/proposals?state=approved', { method: 'GET' });
  assert.ok(approved.body.proposals.length >= 2);
  assert.ok(approved.body.proposals.every((proposal) => proposal.state === 'approved'));
});
