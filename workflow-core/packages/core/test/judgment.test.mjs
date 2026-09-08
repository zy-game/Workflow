// judgment.test.mjs - the loop that turns a due responsibility into a question
// for the user. The commitment model says when it may interrupt; the model
// decides whether it still should, and the loop only ever raises a proposal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { CommitmentRepository } from '../src/commitments/repository.js';
import { createCommitmentService } from '../src/commitments/service.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { createJudgmentLoop } from '../src/judgment/loop.js';
import { ProposalRepository } from '../src/proposals/repository.js';
import { createProposalService } from '../src/proposals/service.js';
import { TaskRepository } from '../src/tasks/repository.js';

let dir;
let auth;
let coreDb;
let commitments;
let proposals;
let server;
let base;
let token;

function fakeLlm(reply, enabled = true) {
  const calls = [];
  return { calls, status: { enabled }, ask: async (messages) => { calls.push(messages); return reply; } };
}

// An `at:` trigger in the past is due on the next tick, deterministically.
function overdue(overrides = {}) {
  return {
    statement: '推进项目 Y',
    trigger_policy: `at:${new Date(Date.now() - 60_000).toISOString()}`,
    attention_policy: 'immediate',
    ...overrides,
  };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-judgment-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDb = new CoreDatabase({ dataDir: dir });
  commitments = createCommitmentService({ commitmentRepository: new CommitmentRepository({ coreDb }) });
  proposals = createProposalService({ proposalRepository: new ProposalRepository({ coreDb }) });
  token = auth.createMachineToken({ subject_id: 'judgment-admin', role: 'admin' }).token;
});

after(() => {
  server?.close();
  coreDb.close();
  auth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing due means no model call at all', async () => {
  const llm = fakeLlm('[]');
  const loop = createJudgmentLoop({ commitmentService: commitments, proposalService: proposals, serverLlm: llm });
  assert.deepEqual(await loop.tick(), { due: 0, raised: 0, reason: 'nothing_due' });
  assert.equal(llm.calls.length, 0);
});

test('a disabled model leaves the cycle unconsumed', async () => {
  commitments.open(overdue({ commitment_id: 'cmt-off' }));
  const loop = createJudgmentLoop({
    commitmentService: commitments, proposalService: proposals, serverLlm: fakeLlm('[]', false),
  });
  const result = await loop.tick();
  assert.equal(result.reason, 'llm_disabled');
  // Still due: the model being down must not silently drop the responsibility.
  assert.equal(commitments.dueForAttention().length, 1);
});

test('the model decides which due responsibilities still matter', async () => {
  const llm = fakeLlm(JSON.stringify([
    { commitment_id: 'cmt-off', title: '项目 Y 停滞', ask: '今天推进吗？', urgency: 'high' },
    { commitment_id: 'does-not-exist', title: 'x', ask: 'y' },
  ]));
  const loop = createJudgmentLoop({ commitmentService: commitments, proposalService: proposals, serverLlm: llm });
  const result = await loop.tick();
  assert.equal(result.due, 1);
  assert.equal(result.raised, 1);

  const created = proposals.get(result.proposals[0].proposalId);
  assert.equal(created.sourceType, 'commitment');
  assert.equal(created.sourceRef, 'cmt-off');
  assert.equal(created.title, '项目 Y 停滞');
  assert.equal(created.urgency, 'high');
  // A reminder is a question for the user; it is never auto-sent.
  assert.equal(created.tier, 'T3');
  assert.equal(created.channelTarget, null);

  // The cycle is consumed: no repeat nagging on the next tick.
  assert.equal((await loop.tick()).due, 0);
});

test('a plan with nothing worth raising still consumes the cycle', async () => {
  commitments.open(overdue({ commitment_id: 'cmt-quiet' }));
  const loop = createJudgmentLoop({
    commitmentService: commitments, proposalService: proposals, serverLlm: fakeLlm('[]'),
  });
  const result = await loop.tick();
  assert.equal(result.due, 1);
  assert.equal(result.raised, 0);
  assert.equal(commitments.dueForAttention().length, 0);
});

test('a malformed reply raises nothing and does not throw', async () => {
  commitments.open(overdue({ commitment_id: 'cmt-bad' }));
  const loop = createJudgmentLoop({
    commitmentService: commitments, proposalService: proposals, serverLlm: fakeLlm('我判断不了'),
  });
  const result = await loop.tick();
  assert.equal(result.raised, 0);
});

test('commitments and the judgment loop are reachable over HTTP', async () => {
  const llm = fakeLlm(JSON.stringify([{ commitment_id: 'cmt-http', title: 'HTTP 责任', ask: '处理吗？' }]));
  const loop = createJudgmentLoop({ commitmentService: commitments, proposalService: proposals, serverLlm: llm });
  const app = createCoreServer({
    config: {}, authRepository: auth, taskRepository: new TaskRepository({ coreDb }),
    commitmentService: commitments, proposalService: proposals, judgmentLoop: loop,
  });
  server = await app.listen({ host: '127.0.0.1', port: 0, tls: null });
  base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const created = await call('POST', '/api/v1/commitments', overdue({ commitment_id: 'cmt-http' }));
  assert.equal(created.status, 200);
  assert.equal(created.body.created, true);

  const listed = await call('GET', '/api/v1/commitments?state=active');
  assert.ok(listed.body.commitments.some((commitment) => commitment.commitmentId === 'cmt-http'));

  const read = await call('GET', '/api/v1/commitments/cmt-http');
  assert.deepEqual(read.body.events.map((event) => event.type), ['created']);

  const tick = await call('POST', '/api/v1/judgment/tick');
  assert.equal(tick.body.raised, 1);

  const fulfilled = await call('POST', '/api/v1/commitments/cmt-http/fulfill');
  assert.equal(fulfilled.body.commitment.state, 'fulfilled');

  const missing = await call('GET', '/api/v1/commitments/nope');
  assert.equal(missing.status, 404);

  const badAction = await call('POST', '/api/v1/commitments/cmt-http/nonsense');
  assert.equal(badAction.status, 400);
});
