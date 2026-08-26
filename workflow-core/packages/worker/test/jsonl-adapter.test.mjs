import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { JsonlCliAdapter } from '../src/adapters/jsonl.js';

function fakeSpawn(requests = []) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    destroyed: false,
    write(value) {
      const request = JSON.parse(String(value));
      requests.push(request);
      if (request.type === 'run' || request.type === 'resume') {
        child.stdout.emit('data', `${JSON.stringify({ type: 'session', session_ref: 'vendor-session-7' })}\n`);
        child.stdout.emit('data', `${JSON.stringify({ type: 'event', event: { type: 'assistant/message', text: request.prompt } })}\n`);
        child.stdout.emit('data', `${JSON.stringify({ type: 'result', result: { summary: 'ok' } })}\n`);
      }
    },
  };
  child.kill = () => { child.stdin.destroyed = true; };
  return child;
}

test('JSONL adapter exposes backend lifecycle and separates run from resume', async () => {
  const requests = [];
  const adapter = new JsonlCliAdapter({ command: 'fake-cli', spawnImpl: () => fakeSpawn(requests) });
  assert.deepEqual(adapter.describe().capabilities, ['run', 'resume', 'inject', 'cancel', 'interaction']);
  assert.deepEqual(await adapter.checkHealth(), { ok: true, command: 'fake-cli' });
  await adapter.start();
  const options = {
    task: { task_id: 't-lifecycle', type: 'cli.run', brief: { goal: 'goal' } },
    conversationId: 'conv-lifecycle', sessionRef: null, workspace: 'E:/project-a',
    signal: new AbortController().signal, emit: () => {}, progress: () => {}, setSessionRef: () => {},
  };
  await adapter.run(options);
  await adapter.resume({ ...options, sessionRef: 'vendor-session-7' });
  assert.deepEqual(requests.map((request) => request.type), ['run', 'resume']);
  assert.equal(requests[0].conversation_id, 'conv-lifecycle');
  assert.equal(requests[1].conversation_id, 'conv-lifecycle');
  adapter.dispose();
});


test('JSONL adapter keeps one child process per Workflow conversation', async () => {
  const children = [];
  const adapter = new JsonlCliAdapter({ command: 'fake-cli', spawnImpl: (...args) => { const child = fakeSpawn(); children.push(child); return child; } });
  const events = [];
  const refs = [];
  const execute = (goal, sessionRef = null) => adapter.execute({
    task: { task_id: `t-${goal}`, type: 'cli.run', brief: { goal } },
    conversationId: 'conv-a', sessionRef, workspace: 'E:/project-a', signal: new AbortController().signal,
    emit: (event) => events.push(event), progress: () => {}, setSessionRef: (ref) => refs.push(ref),
  });
  const first = await execute('first');
  const second = await execute('second', first.sessionRef);
  assert.equal(children.length, 1);
  assert.equal(first.sessionRef, 'vendor-session-7');
  assert.equal(second.sessionRef, 'vendor-session-7');
  assert.deepEqual(refs, ['bridge-conv-a', 'vendor-session-7', 'vendor-session-7', 'vendor-session-7']);
  assert.equal(events.length, 2);
  assert.equal(events[1].text, 'second');
  adapter.close();
});
