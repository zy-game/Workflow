// signals.test.mjs - a signal is evidence, never a trigger. It updates when a
// responsibility last moved; only messages aimed at the user may open one, and
// those open it quietly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CommitmentRepository } from '../src/commitments/repository.js';
import { createCommitmentService } from '../src/commitments/service.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { SignalRepository } from '../src/signals/repository.js';
import { createSignalService } from '../src/signals/service.js';

let dir;
let coreDb;
let commitments;
let signals;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-signals-'));
  coreDb = new CoreDatabase({ dataDir: dir });
  commitments = createCommitmentService({ commitmentRepository: new CommitmentRepository({ coreDb }) });
  signals = createSignalService({
    signalRepository: new SignalRepository({ coreDb }),
    commitmentService: commitments,
  });
});

after(() => {
  coreDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a signal is recorded once per source reference', () => {
  const first = signals.record({ channel: 'feishu', sourceRef: 'msg-1', kind: 'ambient', chatRef: 'oc_a', text: '大家好' });
  assert.equal(first.created, true);
  assert.equal(first.signal.kind, 'ambient');

  const again = signals.record({ channel: 'feishu', sourceRef: 'msg-1', kind: 'mention', chatRef: 'oc_a', text: '重复投递' });
  assert.equal(again.created, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(signals.list({ channel: 'feishu' }).filter((signal) => signal.sourceRef === 'msg-1').length, 1);
});

test('ambient chatter attaches nothing and opens nothing', () => {
  const result = signals.record({ channel: 'feishu', sourceRef: 'msg-2', kind: 'ambient', chatRef: 'oc_a', text: '今天天气不错' });
  assert.equal(result.attached, null);
  assert.equal(result.opened, null);
  assert.equal(result.reason, 'ambient');
  assert.equal(commitments.list({ state: 'active' }).length, 0);
});

test('a directed message attaches to the single matching responsibility', () => {
  const commitment = commitments.open({
    commitment_id: 'cmt-chat',
    statement: '向群 A 答复登录状态',
    channel_ref: 'oc_a',
    trigger_policy: 'on_signal',
    attention_policy: 'immediate',
  }).commitment;

  const result = signals.record({
    channel: 'feishu', sourceRef: 'msg-3', kind: 'mention',
    chatRef: 'oc_a', text: '你那个登录做好了没',
  });
  assert.equal(result.attached, 'cmt-chat');
  assert.equal(result.opened, null);

  const updated = commitments.get('cmt-chat');
  assert.ok(updated.sourceSignalIds.includes(result.signal.signalId));
  assert.ok(updated.lastActivityAt, 'attaching a signal must record activity');
  assert.ok(commitments.events('cmt-chat').some((event) => event.type === 'signal_attached'));
  assert.equal(commitment.commitmentId, updated.commitmentId);
});

test('a directed message with no match opens a quiet responsibility', () => {
  const result = signals.record({
    channel: 'feishu', sourceRef: 'msg-4', kind: 'direct',
    chatRef: 'oc_new', projectId: 'proj-z', text: '下周三的评审记得确认',
  });
  assert.equal(result.attached, null);
  assert.ok(result.opened);
  const opened = commitments.get(result.opened);
  assert.match(opened.statement, /^待确认：/);
  // Quiet by construction: it accumulates into the digest, never interrupts.
  assert.equal(opened.attentionPolicy, 'daily_digest');
  assert.equal(opened.triggerPolicy, 'on_signal');
  assert.deepEqual(opened.sourceSignalIds, [result.signal.signalId]);
});

test('ambiguous matches are left alone rather than guessed', () => {
  commitments.open({ commitment_id: 'cmt-amb-1', statement: '甲', channel_ref: 'oc_many', trigger_policy: 'on_signal' });
  commitments.open({ commitment_id: 'cmt-amb-2', statement: '乙', channel_ref: 'oc_many', trigger_policy: 'on_signal' });
  const result = signals.record({ channel: 'feishu', sourceRef: 'msg-5', kind: 'reply', chatRef: 'oc_many', text: '这个呢' });
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.attached, null);
  assert.equal(result.opened, null);
});

test('an unknown kind degrades to ambient instead of opening work', () => {
  const result = signals.record({ channel: 'feishu', sourceRef: 'msg-6', kind: 'urgent', chatRef: 'oc_a', text: 'x' });
  assert.equal(result.signal.kind, 'ambient');
  assert.equal(result.reason, 'ambient');
});
