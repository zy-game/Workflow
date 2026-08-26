import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CoreDatabase } from '../src/db/core-db.js';
import { InteractionRepository } from '../src/interactions/repository.js';
import { TaskRepository } from '../src/tasks/repository.js';

let dir;
let db;
let tasks;
let interactions;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-interactions-'));
  db = new CoreDatabase({ dataDir: dir });
  tasks = new TaskRepository({ coreDb: db });
  interactions = new InteractionRepository({ coreDb: db });
});

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function task() {
  return tasks.create({
    type: 'workflow.run',
    brief: { goal: 'answer a question' },
    created_by: 'account:owner',
  }).task;
}

function request(taskId, overrides = {}) {
  return {
    interaction_id: `i-${taskId}`,
    task_id: taskId,
    worker_id: 'worker-one',
    backend_kind: 'workflow-jsonl',
    session_ref: 'session-one',
    kind: 'question',
    schema: {
      questions: [{
        id: 'q-confirm',
        required: true,
        options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
      }],
    },
    ...overrides,
  };
}

test('create is idempotent for the same stable interaction request', () => {
  const createdTask = task();
  const input = request(createdTask.task_id);
  const first = interactions.create(input);
  const replay = interactions.create({ ...input, schema: structuredClone(input.schema) });
  assert.equal(replay.interaction_id, first.interaction_id);
  assert.equal(replay.status, 'pending');
  assert.throws(() => interactions.create({ ...input, kind: 'approval' }), /already exists/);
});

test('answers require stable question and option ids', () => {
  const createdTask = task();
  const interaction = interactions.create(request(createdTask.task_id));
  assert.throws(() => interactions.answer(interaction.interaction_id, {
    response_id: 'r-unknown-question', answers: { displayed_text: 'yes' },
  }), /unknown question id/);
  assert.throws(() => interactions.answer(interaction.interaction_id, {
    response_id: 'r-unknown-option', answers: { 'q-confirm': 'Yes' },
  }), /unknown option id/);
  assert.throws(() => interactions.answer(interaction.interaction_id, {
    response_id: 'r-missing', answers: {},
  }), /answer required/);
});

test('response ids are idempotent only for identical response bodies', () => {
  const createdTask = task();
  const interaction = interactions.create(request(createdTask.task_id));
  const response = {
    response_id: 'r-stable', answers: { 'q-confirm': 'yes' }, answered_by: 'account:owner',
  };
  const answered = interactions.answer(interaction.interaction_id, response);
  assert.equal(answered.status, 'answered');
  assert.deepEqual(interactions.answer(interaction.interaction_id, response), answered);
  assert.throws(() => interactions.answer(interaction.interaction_id, {
    ...response, answers: { 'q-confirm': 'no' },
  }), /different response/);
  assert.throws(() => interactions.answer(interaction.interaction_id, {
    ...response, response_id: 'r-other',
  }), /different response/);
});

test('delivered and consumed transitions support reconnect redelivery', () => {
  const createdTask = task();
  const interaction = interactions.create(request(createdTask.task_id, { worker_id: 'worker-delivery' }));
  interactions.answer(interaction.interaction_id, {
    response_id: 'r-delivery', answers: { 'q-confirm': 'yes' },
  });
  assert.equal(interactions.pendingDelivery('worker-delivery').length, 1);
  const delivered = interactions.markDelivered(interaction.interaction_id);
  assert.equal(delivered.status, 'delivered');
  assert.equal(interactions.pendingDelivery('worker-delivery').length, 1);
  assert.throws(() => interactions.markConsumed(interaction.interaction_id, 'worker-two'), /another worker/);
  const consumed = interactions.markConsumed(interaction.interaction_id, 'worker-delivery');
  assert.equal(consumed.status, 'consumed');
  assert.equal(interactions.pendingDelivery('worker-delivery').length, 0);
  assert.equal(interactions.markConsumed(interaction.interaction_id, 'worker-delivery').status, 'consumed');
});

test('expired and cancelled interactions reject responses', () => {
  const expiredTask = task();
  const expired = interactions.create(request(expiredTask.task_id, {
    interaction_id: `i-expired-${expiredTask.task_id}`,
    expires_at: new Date(Date.now() - 1000).toISOString(),
  }));
  assert.throws(() => interactions.answer(expired.interaction_id, {
    response_id: 'r-expired', answers: { 'q-confirm': 'yes' },
  }), /expired/);
  assert.equal(interactions.get(expired.interaction_id).status, 'expired');

  const cancelledTask = task();
  const cancelled = interactions.create(request(cancelledTask.task_id, {
    interaction_id: `i-cancelled-${cancelledTask.task_id}`,
  }));
  assert.equal(interactions.cancel(cancelled.interaction_id).status, 'cancelled');
  assert.throws(() => interactions.answer(cancelled.interaction_id, {
    response_id: 'r-cancelled', answers: { 'q-confirm': 'yes' },
  }), /cancelled/);
});
