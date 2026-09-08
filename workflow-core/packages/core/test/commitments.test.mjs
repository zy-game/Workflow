// commitments.test.mjs - the responsibilities the assistant holds. Two clocks:
// when to re-check (trigger) and when that check may interrupt (attention).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CommitmentRepository } from '../src/commitments/repository.js';
import { createCommitmentService } from '../src/commitments/service.js';
import {
  evaluateAttention, evaluateTrigger, parseAttentionPolicy, parseTriggerPolicy,
} from '../src/commitments/policies.js';
import { CoreDatabase } from '../src/db/core-db.js';

let dir;
let coreDb;
let service;

const DAY = 86_400_000;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-commitments-'));
  coreDb = new CoreDatabase({ dataDir: dir });
  service = createCommitmentService({ commitmentRepository: new CommitmentRepository({ coreDb }) });
});

after(() => {
  coreDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('policies parse only the documented grammar', () => {
  assert.deepEqual(parseTriggerPolicy('on_signal'), { kind: 'on_signal', raw: 'on_signal' });
  assert.equal(parseTriggerPolicy('every:1d').everyMs, DAY);
  assert.equal(parseTriggerPolicy('every:30m').everyMs, 30 * 60_000);
  assert.equal(parseTriggerPolicy('every:soon'), null);
  assert.equal(parseTriggerPolicy('at:not-a-date'), null);
  assert.equal(parseTriggerPolicy('whenever'), null);

  assert.equal(parseAttentionPolicy('immediate').kind, 'immediate');
  assert.equal(parseAttentionPolicy('daily_digest').kind, 'daily_digest');
  const stale = parseAttentionPolicy('threshold:stale>5d');
  assert.deepEqual(
    { metric: stale.metric, comparator: stale.comparator, thresholdMs: stale.thresholdMs },
    { metric: 'stale', comparator: '>', thresholdMs: 5 * DAY },
  );
  assert.equal(parseAttentionPolicy('threshold:stale>5x'), null);
  assert.equal(parseAttentionPolicy('threshold:whatever>5d'), null);
});

test('trigger evaluation keeps the two clocks independent', () => {
  const base = { createdAt: new Date(0).toISOString(), lastEvaluatedAt: new Date(0).toISOString() };
  assert.equal(evaluateTrigger(parseTriggerPolicy('on_signal'), { commitment: base, now: DAY, signalAttached: false }), false);
  assert.equal(evaluateTrigger(parseTriggerPolicy('on_signal'), { commitment: base, now: DAY, signalAttached: true }), true);
  assert.equal(evaluateTrigger(parseTriggerPolicy('every:1d'), { commitment: base, now: DAY - 1 }), false);
  assert.equal(evaluateTrigger(parseTriggerPolicy('every:1d'), { commitment: base, now: DAY }), true);
  assert.equal(evaluateTrigger(parseTriggerPolicy(`at:${new Date(DAY).toISOString()}`), { commitment: base, now: DAY - 1 }), false);
  assert.equal(evaluateTrigger(parseTriggerPolicy(`at:${new Date(DAY).toISOString()}`), { commitment: base, now: DAY }), true);
});

test('attention thresholds read the metric they name', () => {
  const now = 10 * DAY;
  const stale = parseAttentionPolicy('threshold:stale>5d');
  assert.equal(evaluateAttention(stale, { commitment: { lastActivityAt: new Date(now - 6 * DAY).toISOString() }, now }).fire, true);
  assert.equal(evaluateAttention(stale, { commitment: { lastActivityAt: new Date(now - 1 * DAY).toISOString() }, now }).fire, false);

  const dueSoon = parseAttentionPolicy('threshold:due<2d');
  assert.equal(evaluateAttention(dueSoon, { commitment: { dueAt: new Date(now + DAY).toISOString() }, now }).fire, true);
  assert.equal(evaluateAttention(dueSoon, { commitment: { dueAt: new Date(now + 3 * DAY).toISOString() }, now }).fire, false);

  assert.equal(evaluateAttention(parseAttentionPolicy('immediate'), { commitment: {}, now }).fire, true);
  assert.equal(evaluateAttention(parseAttentionPolicy('daily_digest'), { commitment: {}, now }).fire, false);
});

test('a commitment keeps its event log and derives state from it', () => {
  const created = service.open({
    commitment_id: 'cmt-1',
    statement: '保持主线绿',
    trigger_policy: 'every:1d',
    attention_policy: 'threshold:stale>3d',
    project_id: 'proj-a',
  });
  assert.equal(created.created, true);
  assert.equal(created.commitment.state, 'active');
  assert.equal(created.commitment.version, 1);

  const again = service.open({ commitment_id: 'cmt-1', statement: '不同的话' });
  assert.equal(again.created, false);
  assert.equal(again.commitment.statement, '保持主线绿');

  const fulfilled = service.transition({ commitmentId: 'cmt-1', action: 'fulfill' });
  assert.equal(fulfilled.state, 'fulfilled');
  assert.equal(fulfilled.version, 2);
  const events = service.events('cmt-1').map((event) => event.type);
  assert.deepEqual(events, ['created', 'fulfilled']);

  const reactivated = service.transition({ commitmentId: 'cmt-1', action: 'reactivate' });
  assert.equal(reactivated.state, 'active');
  assert.equal(service.events('cmt-1').length, 3);
});

test('dueForAttention applies both clocks and suppresses repeat nagging', () => {
  service.open({
    commitment_id: 'cmt-daily',
    statement: '每日检查构建',
    trigger_policy: 'every:1d',
    attention_policy: 'threshold:stale>3d',
  });
  const now = Date.now();
  service.markEvaluated('cmt-daily', new Date(now - 2 * DAY).toISOString());
  service.markActivity('cmt-daily', new Date(now - 5 * DAY).toISOString());

  // Trigger due (2 days since evaluation) and attention fires (5 days stale).
  const dueIds = (at) => service.dueForAttention({ at }).map((entry) => entry.commitment.commitmentId);
  assert.ok(dueIds(new Date(now).toISOString()).includes('cmt-daily'));

  // Once the user has been told, the same cycle must not nag again.
  service.markAttention('cmt-daily', new Date(now).toISOString());
  assert.ok(!dueIds(new Date(now + 60_000).toISOString()).includes('cmt-daily'));

  // A fresh cycle may speak again.
  service.markEvaluated('cmt-daily', new Date(now + 2 * DAY).toISOString());
  assert.ok(dueIds(new Date(now + 3 * DAY).toISOString()).includes('cmt-daily'));
});

test('a signal-triggered commitment only becomes due when a signal arrives', () => {
  service.open({
    commitment_id: 'cmt-signal',
    statement: '向群里答复登录状态',
    trigger_policy: 'on_signal',
    attention_policy: 'immediate',
  });
  const at = new Date().toISOString();
  assert.equal(service.dueForAttention({ at }).some((entry) => entry.commitment.commitmentId === 'cmt-signal'), false);
  assert.equal(service.dueForAttention({ at, signalIds: ['sig-1'] }).some((entry) => entry.commitment.commitmentId === 'cmt-signal'), true);
});

test('malformed commitments are rejected', () => {
  assert.throws(() => service.open({ statement: '  ' }), /statement is required/);
  assert.throws(() => service.open({ statement: 'x', trigger_policy: 'every:soon' }), /unsupported trigger policy/);
  assert.throws(() => service.open({ statement: 'x', attention_policy: 'threshold:stale>5x' }), /unsupported attention policy/);
  assert.throws(() => service.open({ statement: 'x', due_at: 'nope' }), /due_at must be an ISO timestamp/);
  assert.throws(() => service.transition({ commitmentId: 'cmt-1', action: 'nonsense' }), /action must be one of/);
  assert.throws(() => service.transition({ commitmentId: 'missing', action: 'fulfill' }), /does not exist/);
});
