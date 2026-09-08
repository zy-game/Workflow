// channel-context.test.mjs - the recent past of a channel, bounded twice: by
// age and by line count. Keeping every message forever is useless and a
// privacy liability; keeping none makes "那个 xxxx" meaningless.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { CommitmentRepository } from '../src/commitments/repository.js';
import { createCommitmentService } from '../src/commitments/service.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createMemoryStore } from '../src/memory/store.js';
import { ProposalRepository } from '../src/proposals/repository.js';
import { createProposalService } from '../src/proposals/service.js';
import { ReplyRepository } from '../src/replies/repository.js';
import { WorkflowRepository } from '../src/knowledge/repository.js';
import { channelRefToPath, createChannelContext } from '../src/signals/channel-context.js';
import { SignalRepository } from '../src/signals/repository.js';
import { createSignalService } from '../src/signals/service.js';
import { createResolverService } from '../src/resolve/service.js';

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const DAY = 86_400_000;

let dir;
let coreDb;
let memoryStore;
let context;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-channel-'));
  coreDb = new CoreDatabase({ dataDir: dir });
  memoryStore = createMemoryStore({ root: path.join(dir, 'memory') });
  memoryStore.ensureLayout();
  context = createChannelContext({ memoryStore, maxAgeMs: 3 * DAY, maxLines: 5 });
});

after(() => {
  coreDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a chat reference cannot escape the memory repository', () => {
  assert.equal(channelRefToPath('oc_123'), 'channels/oc_123/recent.md');
  assert.equal(channelRefToPath('../../etc/passwd'), 'channels/.._.._etc_passwd/recent.md');
  assert.ok(channelRefToPath('../../etc').startsWith('channels/'));
});

test('appended lines are readable and carry their time and kind', { skip: !hasGit }, () => {
  context.append('oc_a', { at: new Date().toISOString(), kind: 'mention', text: '你那个登录做好了没' });
  context.append('oc_a', { at: new Date().toISOString(), kind: 'ambient', text: '今天的会推迟了' });
  const lines = context.read('oc_a');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[mention\] 你那个登录做好了没/);
  assert.match(lines[1], /\[ambient\] 今天的会推迟了/);
});

test('expired lines are pruned and the file is capped', { skip: !hasGit }, () => {
  const now = Date.now();
  context.append('oc_b', { at: new Date(now - 10 * DAY).toISOString(), kind: 'ambient', text: '很久以前' });
  assert.deepEqual(context.read('oc_b'), []);

  for (let index = 0; index < 8; index += 1) {
    context.append('oc_b', { at: new Date(now + index).toISOString(), kind: 'ambient', text: `第 ${index} 条` });
  }
  const lines = context.read('oc_b');
  assert.equal(lines.length, 5, 'the line cap must hold');
  assert.match(lines[lines.length - 1], /第 7 条/);
  assert.ok(!lines.some((line) => line.includes('第 2 条')), 'oldest lines must be dropped first');
});

test('an empty observation is not recorded', { skip: !hasGit }, () => {
  assert.equal(context.append('oc_c', { text: '   ' }), null);
  assert.deepEqual(context.read('oc_c'), []);
});

test('recording a signal also writes the channel context', { skip: !hasGit }, () => {
  const commitments = createCommitmentService({ commitmentRepository: new CommitmentRepository({ coreDb }) });
  const signals = createSignalService({
    signalRepository: new SignalRepository({ coreDb }),
    commitmentService: commitments,
    channelContext: context,
  });
  signals.record({ channel: 'feishu', sourceRef: 'msg-ctx', kind: 'reply', chatRef: 'oc_ctx', text: '这个什么时候好' });
  assert.match(signals.context('oc_ctx').join('\n'), /这个什么时候好/);
});

test('a resolution is recorded as feedback with its tier and confidence', { skip: !hasGit }, async () => {
  const knowledge = new WorkflowRepository({ filename: path.join(dir, 'workflow.db') });
  const project = knowledge.resolveProject({
    path: '/srv/login', machine: 'box', metadata: { aliases: ['登录'] },
  });
  const replyRepository = new ReplyRepository({ coreDb });
  const resolver = createResolverService({
    knowledgeRepository: knowledge,
    recordFeedback: (entry) => replyRepository.addFeedback(entry),
  });

  const result = await resolver.resolve({ text: '你那个登录做好了没', channelRef: 'oc_a' });
  assert.equal(result.tier, 'high');

  const feedback = replyRepository.feedbackFor(project.id);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].signal, 'resolved');
  assert.equal(feedback[0].source, 'high');
  knowledge.close();
});
