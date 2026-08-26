import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CORE_FRAME_TYPES, DEFAULT_PRIORITY, INTERACTION_KINDS, PRIORITY_MAX, PRIORITY_MIN,
  PROTOCOL_VERSION, WORKER_FRAME_TYPES, frame, isCoreFrame, isWorkerFrame, parseFrame,
  validateInteractionRequest, validateInteractionResponse,
} from '../src/index.js';

test('frame builds a typed envelope with unique id and timestamp', () => {
  const value = frame('heartbeat', { load: 1 });
  assert.equal(value.type, 'heartbeat');
  assert.match(value.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.ok(Date.parse(value.ts) > 0);
  assert.deepEqual(value.payload, { load: 1 });
  assert.equal(PROTOCOL_VERSION, 4);
});

test('parseFrame rejects malformed envelopes', () => {
  assert.equal(parseFrame(null), null);
  assert.equal(parseFrame('x'), null);
  assert.equal(parseFrame({ type: 'BadType', id: 'a', payload: {} }), null);
  assert.equal(parseFrame({ type: 'ok', id: '', payload: {} }), null);
  assert.equal(parseFrame({ type: 'ok', id: 'a', payload: 'str' }), null);
  assert.equal(parseFrame({ type: 'ok', id: 'a', ts: 'not-a-date' }), null);
  const parsed = parseFrame({ type: 'progress', id: 'f1', payload: { percent: 10 } });
  assert.equal(parsed.type, 'progress');
  assert.deepEqual(parsed.payload, { percent: 10 });
});

test('frame directions expose only the Worker v4 control channel', () => {
  assert.deepEqual(WORKER_FRAME_TYPES, [
    'register', 'heartbeat', 'status', 'progress', 'session_event',
    'interaction_required', 'interaction_resolved', 'task_done', 'task_failed', 'error',
  ]);
  assert.deepEqual(CORE_FRAME_TYPES, [
    'config', 'dispatch', 'inject', 'cancel', 'pause', 'resume',
  'interaction_response', 'interaction_cancel', 'ping', 'ack', 'error',
]);
  assert.ok(isWorkerFrame(frame('task_done', {})));
  assert.ok(isCoreFrame(frame('cancel', {})));
  assert.ok(!isWorkerFrame(frame('dispatch', {})));
  for (const obsolete of ['approval_request', 'approval_result', 'models', 'capabilities_update']) {
    assert.equal(isWorkerFrame(frame(obsolete, {})), false);
    assert.equal(isCoreFrame(frame(obsolete, {})), false);
  }
});

test('interaction payloads require stable ids and supported kinds', () => {
  const request = validateInteractionRequest({
    interaction_id: 'i-1', task_id: 't-1', kind: 'question',
    schema: { questions: [{ id: 'q-1' }] },
  });
  assert.equal(request.kind, 'question');
  assert.throws(() => validateInteractionRequest({ interaction_id: 'i-1', task_id: 't-1', kind: 'unknown' }));
  assert.deepEqual(
    validateInteractionResponse({ interaction_id: 'i-1', response_id: 'r-1', answers: { 'q-1': 'yes' } }).answers,
    { 'q-1': 'yes' },
  );
  assert.throws(() => validateInteractionResponse({ interaction_id: 'i-1' }));
  assert.ok(INTERACTION_KINDS.includes('credential'));
  assert.ok(DEFAULT_PRIORITY >= PRIORITY_MIN && DEFAULT_PRIORITY <= PRIORITY_MAX);
});
