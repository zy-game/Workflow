import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DshLocal } from '../src/dsh-local.js';
import { TaskRunner } from '../src/runner.js';
import { WorkerStateStore } from '../src/state-store.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function task(overrides = {}) {
  return {
    task_id: 't-resume',
    claim_token: 'claim-1',
    type: 'dsh.run',
    brief: { goal: 'continue safely' },
    ...overrides,
  };
}

function fakeDsh({ events = [], pollError = null } = {}) {
  const calls = { create: 0, prompt: 0, cancel: [], export: 0, poll: [] };
  return {
    calls,
    async createSession() {
      calls.create += 1;
      return { sessionId: 's-existing' };
    },
    async prompt() {
      calls.prompt += 1;
    },
    async cancel(sessionId) {
      calls.cancel.push(sessionId);
    },
    async pollEvents(sessionId, lastSeq) {
      calls.poll.push({ sessionId, lastSeq });
      if (pollError) throw pollError;
      return {
        lastSeq: events.at(-1)?.seq ?? lastSeq,
        events: events.filter((event) => event.seq > lastSeq),
        hasMore: false,
      };
    },
    async exportSession() {
      calls.export += 1;
      return { format: 'dsh-logical-session-v1', events };
    },
  };
}

function fakeCore({ connected = true, failTypes = [] } = {}) {
  const frames = [];
  return {
    frames,
    send(type, payload) {
      if (!connected || failTypes.includes(type)) return false;
      frames.push({ type, payload });
      return true;
    },
  };
}

test('WorkerStateStore persists session state across close and reopen', () => {
  const dir = tempDir('wfc-worker-state-');
  try {
    const first = new WorkerStateStore({ dataDir: dir });
    first.put({
      taskId: 't-1',
      claimToken: 'claim-1',
      sessionId: 's-1',
      lastSeq: 41,
      lastAssistant: 'still working',
      phase: 'running',
    });
    first.close();

    const second = new WorkerStateStore({ dataDir: dir });
    assert.deepEqual(second.get('t-1'), {
      taskId: 't-1',
      claimToken: 'claim-1',
      sessionId: 's-1',
      lastSeq: 41,
      lastAssistant: 'still working',
      phase: 'running',
      updatedAt: second.get('t-1').updatedAt,
    });
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resumed dispatch reuses the persisted DSH session without prompting again', async () => {
  const dir = tempDir('wfc-worker-resume-');
  try {
    const stateStore = new WorkerStateStore({ dataDir: dir });
    stateStore.put({
      taskId: 't-resume',
      claimToken: 'claim-1',
      sessionId: 's-existing',
      lastSeq: 7,
      lastAssistant: 'checkpoint',
      phase: 'running',
    });
    const dsh = fakeDsh();
    const core = fakeCore();
    const runner = new TaskRunner({ core, dsh, stateStore, pollMs: 60_000 });

    assert.equal(await runner.handleDispatch(task(), { resumed: true }), true);
    assert.equal(dsh.calls.create, 0);
    assert.equal(dsh.calls.prompt, 0);
    assert.ok(dsh.calls.poll.every((call) => call.sessionId === 's-existing'));
    assert.ok(dsh.calls.poll.every((call) => call.lastSeq === 7));

    await runner.detachAll();
    assert.deepEqual(dsh.calls.cancel, []);
    assert.equal(stateStore.get('t-resume').sessionId, 's-existing');
    stateStore.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resumed dispatch fails closed when local state is missing or ambiguous', async () => {
  const dir = tempDir('wfc-worker-missing-');
  try {
    const stateStore = new WorkerStateStore({ dataDir: dir });
    const dsh = fakeDsh();
    const runner = new TaskRunner({ core: fakeCore(), dsh, stateStore });

    await assert.rejects(
      runner.handleDispatch(task(), { resumed: true }),
      (error) => error.code === 'resume_state_missing',
    );
    stateStore.put({
      taskId: 't-resume', claimToken: 'claim-1', sessionId: 's-existing', phase: 'prompting',
    });
    await assert.rejects(
      runner.handleDispatch(task(), { resumed: true }),
      (error) => error.code === 'resume_state_ambiguous',
    );
    assert.equal(dsh.calls.create, 0);
    assert.equal(dsh.calls.prompt, 0);
    stateStore.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resumed dispatch deletes a mapping only when DSH reports not_found', async () => {
  const dir = tempDir('wfc-worker-not-found-');
  try {
    const stateStore = new WorkerStateStore({ dataDir: dir });
    stateStore.put({
      taskId: 't-resume', claimToken: 'claim-1', sessionId: 's-missing', phase: 'running',
    });
    const error = new Error('no session');
    error.code = 'not_found';
    const runner = new TaskRunner({ core: fakeCore(), dsh: fakeDsh({ pollError: error }), stateStore });

    await assert.rejects(
      runner.handleDispatch(task(), { resumed: true }),
      (caught) => caught.code === 'dsh_session_missing',
    );
    assert.equal(stateStore.get('t-resume'), null);
    stateStore.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resumed dispatch preserves state and retries after transient DSH errors', async () => {
  const dir = tempDir('wfc-worker-transient-');
  try {
    const stateStore = new WorkerStateStore({ dataDir: dir });
    stateStore.put({
      taskId: 't-resume', claimToken: 'claim-1', sessionId: 's-existing', phase: 'running',
    });
    let polls = 0;
    const dsh = fakeDsh();
    dsh.pollEvents = async (sessionId, lastSeq) => {
      polls += 1;
      if (polls === 1) {
        const error = new Error('connection refused');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      dsh.calls.poll.push({ sessionId, lastSeq });
      return { lastSeq, events: [], hasMore: false };
    };
    const runner = new TaskRunner({
      core: fakeCore(), dsh, stateStore, pollMs: 5,
    });

    assert.equal(await runner.handleDispatch(task(), { resumed: true }), true);
    const deadline = Date.now() + 1_000;
    while (polls < 2) {
      if (Date.now() > deadline) throw new Error('timeout waiting for DSH retry');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(stateStore.get('t-resume').sessionId, 's-existing');
    assert.equal(dsh.calls.create, 0);
    assert.equal(dsh.calls.prompt, 0);
    await runner.detachAll();
    stateStore.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('completion_pending survives a disconnected Core and is resent on resume', async () => {
  const dir = tempDir('wfc-worker-completion-');
  let stateStore;
  try {
    stateStore = new WorkerStateStore({ dataDir: dir });
    const events = [{
      kind: 'other', seq: 0, event: { seq: 0, type: 'turn/end', data: { reason: 'stop' } },
    }];
    const dsh = fakeDsh({ events });
    const disconnected = new TaskRunner({
      core: fakeCore({ failTypes: ['task_done'] }), dsh, stateStore, pollMs: 5,
    });
    await disconnected.handleDispatch(task());
    const deadline = Date.now() + 1_000;
    while (stateStore.get('t-resume')?.phase !== 'completion_pending') {
      if (Date.now() > deadline) throw new Error('timeout waiting for completion_pending');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await disconnected.detachAll();

    const connectedCore = fakeCore();
    const resumed = new TaskRunner({ core: connectedCore, dsh, stateStore, pollMs: 60_000 });
    await resumed.handleDispatch(task(), { resumed: true });
    assert.equal(dsh.calls.create, 1);
    assert.equal(dsh.calls.prompt, 1);
    assert.equal(connectedCore.frames.filter((entry) => entry.type === 'task_done').length, 1);
    assert.equal(stateStore.get('t-resume'), null);
  } finally {
    stateStore?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit cancel removes persisted state while detach preserves it', async () => {
  const dir = tempDir('wfc-worker-cancel-');
  try {
    const stateStore = new WorkerStateStore({ dataDir: dir });
    stateStore.put({
      taskId: 't-resume', claimToken: 'claim-1', sessionId: 's-existing', phase: 'running',
    });
    const dsh = fakeDsh();
    const runner = new TaskRunner({ core: fakeCore(), dsh, stateStore });

    assert.equal(await runner.handleCancel('t-resume'), true);
    assert.deepEqual(dsh.calls.cancel, ['s-existing']);
    assert.equal(stateStore.get('t-resume'), null);
    stateStore.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detach waits for an in-flight dispatch before closing persistent state', async () => {
  const dir = tempDir('wfc-worker-dispatch-drain-');
  try {
    const stateStore = new WorkerStateStore({ dataDir: dir });
    let releasePrompt;
    let promptStarted;
    const started = new Promise((resolve) => { promptStarted = resolve; });
    const dsh = fakeDsh();
    dsh.prompt = async () => {
      dsh.calls.prompt += 1;
      promptStarted();
      await new Promise((resolve) => { releasePrompt = resolve; });
    };
    const runner = new TaskRunner({ core: fakeCore(), dsh, stateStore, pollMs: 60_000 });
    const dispatching = runner.handleDispatch(task());
    await started;

    let detached = false;
    const stopping = runner.detachAll().then(() => { detached = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(detached, false);
    releasePrompt();
    assert.equal(await dispatching, true);
    await stopping;
    assert.equal(stateStore.get('t-resume').phase, 'running');
    stateStore.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detach waits for an in-flight poll before the state store closes', async () => {
  const dir = tempDir('wfc-worker-inflight-');
  try {
    const stateStore = new WorkerStateStore({ dataDir: dir });
    stateStore.put({
      taskId: 't-resume', claimToken: 'claim-1', sessionId: 's-existing', phase: 'running',
    });
    let releasePoll;
    let pollStarted;
    const started = new Promise((resolve) => { pollStarted = resolve; });
    const dsh = fakeDsh();
    let polls = 0;
    dsh.pollEvents = async () => {
      polls += 1;
      if (polls <= 2) return { lastSeq: -1, events: [], hasMore: false };
      pollStarted();
      await new Promise((resolve) => { releasePoll = resolve; });
      return {
        lastSeq: 0,
        events: [{ kind: 'assistant', seq: 0, event: { seq: 0, type: 'assistant/message', data: { text: 'late' } } }],
        hasMore: false,
      };
    };
    const runner = new TaskRunner({ core: fakeCore(), dsh, stateStore, pollMs: 5 });
    await runner.handleDispatch(task(), { resumed: true });
    await started;

    let detached = false;
    const stopping = runner.detachAll().then(() => { detached = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(detached, false);
    releasePoll();
    await stopping;
    stateStore.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DshLocal pollEvents pages through more than 200 unseen events in order', async () => {
  const allEvents = Array.from({ length: 450 }, (_, seq) => ({
    event: { seq, type: seq % 2 ? 'assistant/message' : 'tool/call', data: { seq } },
  }));
  let calls = 0;
  const dsh = new DshLocal({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async (_url, options) => {
      calls += 1;
      const { rpcId, payload } = JSON.parse(options.body);
      let candidates = allEvents;
      if (Number.isSafeInteger(payload.beforeSeq)) {
        candidates = candidates.filter((entry) => entry.event.seq < payload.beforeSeq);
      }
      const descending = [...candidates].sort((left, right) => right.event.seq - left.event.seq);
      const selected = descending.slice(0, payload.maxMessages).reverse();
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId,
        result: {
          ok: true,
          value: { events: selected, hasMore: descending.length > selected.length },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const result = await dsh.pollEvents('s-many', 124);
  assert.equal(calls, 2);
  assert.equal(result.events.length, 325);
  assert.equal(result.events[0].seq, 125);
  assert.equal(result.events.at(-1).seq, 449);
  assert.deepEqual(result.events.map((entry) => entry.seq), Array.from({ length: 325 }, (_, index) => index + 125));
});
