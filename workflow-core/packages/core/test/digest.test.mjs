// digest.test.mjs - the daily summary of everything that was not urgent. A
// stream of small interruptions is how an assistant becomes noise, so quiet
// responsibilities arrive together, once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { CommitmentRepository } from '../src/commitments/repository.js';
import { createCommitmentService } from '../src/commitments/service.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createDigestService } from '../src/digest/service.js';
import { createCoreServer } from '../src/http/server.js';
import { ProposalRepository } from '../src/proposals/repository.js';
import { createProposalService } from '../src/proposals/service.js';
import { TaskRepository } from '../src/tasks/repository.js';

let dir;
let auth;
let coreDb;
let commitments;
let proposals;
let digest;
let server;
let base;
let token;

function quiet(statement, overrides = {}) {
  return commitments.open({
    statement,
    trigger_policy: 'on_signal',
    attention_policy: 'daily_digest',
    ...overrides,
  }).commitment;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-digest-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDb = new CoreDatabase({ dataDir: dir });
  commitments = createCommitmentService({ commitmentRepository: new CommitmentRepository({ coreDb }) });
  proposals = createProposalService({ proposalRepository: new ProposalRepository({ coreDb }) });
  digest = createDigestService({ commitmentService: commitments, proposalService: proposals });
  token = auth.createMachineToken({ subject_id: 'digest-admin', role: 'admin' }).token;
});

after(() => {
  server?.close();
  coreDb.close();
  auth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing quiet means nothing is built', () => {
  assert.deepEqual(digest.build(), { built: false, items: 0, reason: 'empty' });
});

test('quiet responsibilities arrive together in one low-urgency proposal', () => {
  quiet('待确认：下周三的评审时间', { project_id: 'proj-z' });
  quiet('待确认：给 X 的构建脚本');

  const pending = digest.pending();
  assert.equal(pending.length, 2);

  const result = digest.build();
  assert.equal(result.built, true);
  assert.equal(result.items, 2);

  const proposal = proposals.get(result.proposalId);
  assert.equal(proposal.sourceType, 'digest');
  assert.match(proposal.title, /每日摘要 · 2 条/);
  assert.match(proposal.ask, /下周三的评审时间/);
  assert.match(proposal.ask, /给 X 的构建脚本/);
  assert.match(proposal.ask, /项目 proj-z/);
  assert.equal(proposal.urgency, 'low');
  // A digest is a question for the user; it is never sent anywhere.
  assert.equal(proposal.tier, 'T3');
  assert.equal(proposal.channelTarget, null);
});

test('a delivered item is not repeated', () => {
  assert.equal(digest.pending().length, 0);
  assert.deepEqual(digest.build(), { built: false, items: 0, reason: 'empty' });
});

test('an urgent responsibility is never batched into the digest', () => {
  commitments.open({
    commitment_id: 'cmt-loud',
    statement: '构建红了',
    trigger_policy: 'every:1d',
    attention_policy: 'immediate',
  });
  assert.equal(digest.pending().some((commitment) => commitment.commitmentId === 'cmt-loud'), false);
});

test('the digest is reachable over HTTP', async () => {
  quiet('待确认：确认发布窗口');
  const app = createCoreServer({
    config: {}, authRepository: auth, taskRepository: new TaskRepository({ coreDb }),
    commitmentService: commitments, proposalService: proposals, digestService: digest,
  });
  server = await app.listen({ host: '127.0.0.1', port: 0, tls: null });
  base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname) => {
    const response = await fetch(`${base}${pathname}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    return { status: response.status, body: await response.json() };
  };

  const pending = await call('GET', '/api/v1/digest/pending');
  assert.equal(pending.body.count, 1);

  const built = await call('POST', '/api/v1/digest/build');
  assert.equal(built.body.built, true);
  assert.equal(built.body.items, 1);

  assert.equal((await call('GET', '/api/v1/digest/pending')).body.count, 0);
});
