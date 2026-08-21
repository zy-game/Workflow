import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CORE_FRAME_TYPES, DEFAULT_PRIORITY, PRIORITY_MAX, PRIORITY_MIN, PROTOCOL_VERSION,
  WORKER_FRAME_TYPES, frame, isCoreFrame, isWorkerFrame, modelPushEntry, parseFrame,
} from '../src/index.js';

test('frame builds a typed envelope with unique id and timestamp', () => {
  const value = frame('heartbeat', { load: 1 });
  assert.equal(value.type, 'heartbeat');
  assert.match(value.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.ok(Date.parse(value.ts) > 0);
  assert.deepEqual(value.payload, { load: 1 });
  assert.equal(PROTOCOL_VERSION, 1);
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

test('frame direction sets cover the worker control channel', () => {
  assert.ok(WORKER_FRAME_TYPES.includes('session_event'));
  assert.ok(WORKER_FRAME_TYPES.includes('approval_request'));
  assert.ok(CORE_FRAME_TYPES.includes('dispatch'));
  assert.ok(CORE_FRAME_TYPES.includes('inject'));
  assert.ok(CORE_FRAME_TYPES.includes('models'));
  assert.ok(isWorkerFrame(frame('task_done', {})));
  assert.ok(isCoreFrame(frame('cancel', {})));
  assert.ok(!isWorkerFrame(frame('dispatch', {})));
});

test('modelPushEntry validates the pushed model config shape', () => {
  const entry = modelPushEntry({ provider: 'deepseek-official', model: 'deepseek-v4-flash', key: 'sk-test', baseUrl: 'https://api.example.com', priority: 0 });
  assert.deepEqual(entry, { provider: 'deepseek-official', model: 'deepseek-v4-flash', key: 'sk-test', baseUrl: 'https://api.example.com', priority: 0 });
  assert.throws(() => modelPushEntry({ provider: '', model: 'm', key: 'k', baseUrl: 'https://x.example.com', priority: 0 }));
  assert.throws(() => modelPushEntry({ provider: 'p', model: '', key: 'k', baseUrl: 'https://x.example.com', priority: 0 }));
  assert.throws(() => modelPushEntry({ provider: 'p', model: 'm', key: 'k', baseUrl: 'ftp://x', priority: 0 }));
  assert.throws(() => modelPushEntry({ provider: 'p', model: 'm', key: 'k', baseUrl: 'https://x', priority: PRIORITY_MAX + 1 }));
  assert.ok(DEFAULT_PRIORITY >= PRIORITY_MIN && DEFAULT_PRIORITY <= PRIORITY_MAX);
});
