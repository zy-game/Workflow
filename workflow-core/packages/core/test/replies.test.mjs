// replies.test.mjs - turning an approved proposal into an outbound message.
// Nothing is sent without a tier that permits autonomy, nothing is sent before
// audience filtering, and every attempt leaves an audit row.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CoreDatabase } from '../src/db/core-db.js';
import { SettingsRepository } from '../src/settings/repository.js';
import { ProposalRepository } from '../src/proposals/repository.js';
import { createProposalService } from '../src/proposals/service.js';
import { ReplyRepository } from '../src/replies/repository.js';
import { createReplyService, filterForAudience } from '../src/replies/service.js';

let dir;
let coreDb;
let proposals;
let replies;
let feishu;
let service;

function fakeFeishu() {
  const sent = [];
  return {
    sent,
    sendText: async (id, text, options) => {
      sent.push({ id, text, options });
      return { message_id: `m-${sent.length}` };
    },
  };
}

function open(overrides = {}) {
  const result = proposals.open({
    source_type: 'probe',
    source_ref: 'probe-1',
    channel_target: 'feishu:chat:oc_123',
    title: '项目 A：登录功能状态回复',
    ask: '群里有人问"登录做好了没"。是否以此回复？',
    draft_text: '已完成，版本 v1.4.2',
    evidence: [{ kind: 'commit', ref: 'a41f9c2' }],
    ...overrides,
  });
  return result.proposal;
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-replies-'));
  coreDb = new CoreDatabase({ dataDir: dir });
  proposals = createProposalService({ proposalRepository: new ProposalRepository({ coreDb }) });
  replies = new ReplyRepository({ coreDb });
  feishu = fakeFeishu();
  service = createReplyService({
    replyRepository: replies, proposalService: proposals,
    settingsRepository: new SettingsRepository({ coreDb }), feishuClient: feishu,
  });
});

after(() => {
  coreDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the audience filter hides paths and credentials and trims length', () => {
  const filtered = filterForAudience('部署在 /opt/workflow-core/releases 里，token: sk-abcdefghijklmnop');
  assert.doesNotMatch(filtered, /\/opt\/workflow-core/);
  assert.doesNotMatch(filtered, /sk-abcdefghijklmnop/);
  assert.match(filtered, /\[路径已隐藏\]/);
  assert.match(filtered, /\[凭据已隐藏\]/);
  assert.equal(filterForAudience('x'.repeat(700)).length, 601);
});

test('an approved proposal is sent once and audited with its evidence', async () => {
  const proposal = open({ proposal_id: 'prop-send' });
  proposals.decide({ proposalId: proposal.proposalId, action: 'approve' });
  const result = await service.send({ proposalId: proposal.proposalId, autonomy: 'user' });
  assert.equal(result.sent, true);
  assert.equal(feishu.sent.length, 1);
  assert.equal(feishu.sent[0].id, 'oc_123');
  assert.deepEqual(feishu.sent[0].options, { receiveIdType: 'chat_id' });
  assert.equal(result.reply.tier, 'T2');
  assert.equal(result.reply.autonomy, 'user');
  assert.equal(result.reply.messageRef, 'm-1');
  assert.equal(result.reply.evidence[0].ref, 'a41f9c2');

  const again = await service.send({ proposalId: proposal.proposalId });
  assert.equal(again.sent, false);
  assert.equal(feishu.sent.length, 1);
  assert.equal(service.list().length, 1);
});

test('the sent text is the filtered draft, not the raw one', async () => {
  const proposal = open({
    proposal_id: 'prop-filter',
    draft_text: '已完成，产物在 /opt/workflow-core/releases/abc',
  });
  proposals.decide({ proposalId: proposal.proposalId, action: 'approve' });
  await service.send({ proposalId: proposal.proposalId });
  const last = feishu.sent[feishu.sent.length - 1];
  assert.doesNotMatch(last.text, /\/opt\//);
  assert.match(last.text, /\[路径已隐藏\]/);
});

test('T3 and unapproved proposals are refused', async () => {
  const pending = open({ proposal_id: 'prop-pending' });
  await assert.rejects(
    () => service.send({ proposalId: pending.proposalId }),
    /only an approved proposal/,
  );
  const approved = open({ proposal_id: 'prop-t3', tier: 'T3' });
  proposals.decide({ proposalId: approved.proposalId, action: 'approve' });
  await assert.rejects(
    () => service.send({ proposalId: approved.proposalId }),
    /may not be sent autonomously/,
  );
  assert.equal(feishu.sent.length, 2);
});

test('an unsupported channel target is refused before any send', async () => {
  const proposal = open({ proposal_id: 'prop-badtarget', channel_target: 'slack:chat:x' });
  proposals.decide({ proposalId: proposal.proposalId, action: 'approve' });
  await assert.rejects(
    () => service.send({ proposalId: proposal.proposalId }),
    /unsupported channel target/,
  );
  assert.equal(replies.forProposal('prop-badtarget'), null);
});

test('sendApproved sends an approved draft once and skips the rest', async () => {
  const withDraft = open({ proposal_id: 'prop-sweep' });
  proposals.decide({ proposalId: withDraft.proposalId, action: 'approve', });
  const noDraft = open({ proposal_id: 'prop-nodraft', draft_text: null });
  proposals.decide({ proposalId: noDraft.proposalId, action: 'approve' });
  const before = feishu.sent.length;
  const sent = await service.sendApproved();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].proposalId, 'prop-sweep');
  assert.equal(feishu.sent.length, before + 1);
  assert.equal((await service.sendApproved()).length, 0);
});

test('a rejection is recorded as feedback', () => {
  const proposal = open({ proposal_id: 'prop-veto' });
  proposals.decide({ proposalId: proposal.proposalId, action: 'reject' });
  service.recordVeto(proposal.proposalId);
  const feedback = replies.feedbackFor(proposal.proposalId);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].signal, 'veto');
});

test('the group audience also hides internal identifiers', () => {
  const text = '任务 task-01927bf6-6158-4e1a-a401-02b6451bd31a 已完成';
  assert.match(filterForAudience(text, { audience: 'private' }), /task-01927bf6/);
  assert.doesNotMatch(filterForAudience(text, { audience: 'group' }), /task-01927bf6/);
  assert.throws(() => filterForAudience(text, { audience: 'public' }), /audience must be one of/);
});

test('a group reply is filtered by its audience, not by the caller', async () => {
  const proposal = open({
    proposal_id: 'prop-group',
    draft_text: '任务 task-01927bf6-6158-4e1a-a401-02b6451bd31a 已完成',
  });
  proposals.decide({ proposalId: proposal.proposalId, action: 'approve' });
  await service.send({ proposalId: proposal.proposalId });
  const sent = feishu.sent[feishu.sent.length - 1];
  assert.doesNotMatch(sent.text, /task-01927bf6/, 'a group reply must not carry internal identifiers');
});

test('the kill switch stops autonomous replies, globally and per channel', async () => {
  assert.deepEqual(service.policy(), { global: true, channels: {} });

  service.setPolicy({ channels: { 'feishu:chat:oc_123': false } });
  const blocked = open({ proposal_id: 'prop-blocked' });
  proposals.decide({ proposalId: blocked.proposalId, action: 'approve' });
  await assert.rejects(() => service.send({ proposalId: blocked.proposalId }), /disabled for feishu:chat:oc_123/);

  service.setPolicy({ global: false });
  const other = open({ proposal_id: 'prop-global-off', channel_target: 'feishu:user:ou_1' });
  proposals.decide({ proposalId: other.proposalId, action: 'approve' });
  await assert.rejects(() => service.send({ proposalId: other.proposalId }), /disabled globally/);

  service.setPolicy({ global: true, channels: { 'feishu:chat:oc_123': true } });
  const allowed = open({ proposal_id: 'prop-allowed' });
  proposals.decide({ proposalId: allowed.proposalId, action: 'approve' });
  assert.equal((await service.send({ proposalId: allowed.proposalId })).sent, true);
});

test('each tier has to be true at creation time', () => {
  assert.throws(
    () => proposals.open({ proposal_id: 't1-bare', tier: 'T1', title: 'x', ask: 'y' }),
    /a T1 proposal must carry evidence/,
  );
  assert.throws(
    () => proposals.open({ proposal_id: 't2-bare', tier: 'T2', title: 'x', ask: 'y' }),
    /a T2 proposal must reference the record/,
  );
  // T3 makes no claim, so it needs neither.
  assert.ok(proposals.open({ proposal_id: 't3-bare', tier: 'T3', title: 'x', ask: 'y' }).proposal);
});
