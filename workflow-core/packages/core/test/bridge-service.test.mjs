import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BridgeRequestsRepository } from '../src/bridge/requests-repository.js';
import {
  BRIDGE_MAX_EVENT_BYTES,
  BRIDGE_MAX_EVENTS,
  BRIDGE_MAX_EVENTS_BYTES,
  createBridgeService,
} from '../src/bridge/service.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { InteractionRepository } from '../src/interactions/repository.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { WorkersRegistry } from '../src/workers/registry.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-bridge-service-'));
  const core = new CoreDatabase({ dataDir: dir });
  const taskRepository = new TaskRepository({ coreDb: core });
  const workersRegistry = new WorkersRegistry({ coreDb: core });
  const interactionRepository = new InteractionRepository({ coreDb: core });
  const bridgeRequestsRepository = new BridgeRequestsRepository({ coreDb: core });
  const clock = { value: new Date() };
  const service = createBridgeService({
    bridgeRequestsRepository,
    workersRegistry,
    taskRepository,
    interactionRepository,
    now: () => clock.value,
  });
  return {
    core,
    clock,
    taskRepository,
    workersRegistry,
    interactionRepository,
    bridgeRequestsRepository,
    service,
    close() {
      core.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function register(value, overrides = {}) {
  return value.service.register({
    bridgeId: 'bridge-1',
    subjectId: 'machine:bridge-1',
    tokenProjects: ['project-a'],
    requestId: 'register-1',
    protocolVersion: 1,
    metadata: {
      projects: ['project-a'],
      max_concurrency: 2,
      capabilities: ['run'],
      backends: [{ kind: 'workflow-jsonl', capabilities: ['run'] }],
    },
    ...overrides,
  });
}

function createTask(value, idempotencyKey, projectId = 'project-a') {
  return value.taskRepository.create({
    type: 'code',
    brief: { prompt: idempotencyKey },
    created_by: 'test',
    project_id: projectId,
    idempotency_key: idempotencyKey,
    backend_kind: 'workflow-jsonl',
    required_capabilities: ['run'],
  }).task;
}

test('register derives worker identity from caller and narrows project scope', () => {
  const value = fixture();
  try {
    const result = register(value);
    assert.equal(result.status, 200);
    assert.equal(result.response.ok, true);
    assert.equal(result.response.protocol_version, 1);
    assert.equal(result.response.server_time, value.clock.value.toISOString());
    assert.deepEqual(result.response.worker.projects, ['project-a']);
    assert.equal(result.response.worker.transport, 'pull');
    assert.equal(result.response.worker.bridge_protocol_version, 1);

    assert.throws(
      () => value.service.register({
        bridgeId: 'bridge-2',
        subjectId: 'machine:bridge-2',
        tokenProjects: ['project-a'],
        requestId: 'register-forbidden',
        protocolVersion: 1,
        metadata: { projects: ['project-b'] },
      }),
      (error) => error?.code === 'BRIDGE_PROJECT_FORBIDDEN' && error.status === 403,
    );
    assert.throws(
      () => value.service.register({
        bridgeId: 'bridge-2',
        subjectId: 'machine:bridge-2',
        tokenProjects: ['*'],
        requestId: 'register-version',
        protocolVersion: 2,
      }),
      (error) => error?.code === 'BRIDGE_PROTOCOL_UNSUPPORTED' && error.status === 426,
    );
  } finally {
    value.close();
  }
});

test('pull returns live claims first, fills concurrency, and replays the original response', () => {
  const value = fixture();
  try {
    register(value);
    createTask(value, 'task-1');
    createTask(value, 'task-2');
    createTask(value, 'task-3');

    const first = value.service.pull({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'pull-1', protocolVersion: 1,
    });
    assert.equal(first.replayed, false);
    assert.equal(first.response.claims.length, 2);
    assert.deepEqual(first.response.claims.map((claim) => claim.resumed), [false, false]);

    const replay = value.service.pull({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'pull-1', protocolVersion: 1,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.response, first.response);
    assert.equal(value.taskRepository.activeForWorker('bridge-1').length, 2);

    const next = value.service.pull({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'pull-2', protocolVersion: 1,
    });
    assert.equal(next.response.claims.length, 2);
    assert.deepEqual(next.response.claims.map((claim) => claim.resumed), [true, true]);
    assert.ok(value.workersRegistry.get('bridge-1').last_pull_at);
  } finally {
    value.close();
  }
});

test('task mutations enforce ownership, token, live lease, event bounds, and one progress call', () => {
  const value = fixture();
  try {
    register(value);
    createTask(value, 'task-progress');
    const claim = value.service.pull({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'pull-progress', protocolVersion: 1,
    }).response.claims[0];

    let progressCalls = 0;
    const originalProgress = value.taskRepository.progress.bind(value.taskRepository);
    value.taskRepository.progress = (...args) => {
      progressCalls += 1;
      return originalProgress(...args);
    };
    const event = { event_id: 'client-event-1', type: 'output', text: 'hello' };
    const progressed = value.service.progress({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'progress-1', protocolVersion: 1,
      taskId: claim.task.task_id, claimToken: claim.lease.claim_token, note: 'working', percent: 25, events: [event],
    });
    assert.equal(progressed.response.task.status, 'running');
    assert.equal(progressCalls, 1);
    assert.deepEqual(
      value.taskRepository.events(claim.task.task_id, { type: 'session_event' }).at(-1).payload,
      event,
    );

    assert.throws(
      () => value.service.progress({
        bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'progress-bad-token', protocolVersion: 1,
        taskId: claim.task.task_id, claimToken: 'forged', events: [],
      }),
      (error) => error?.code === 'CLAIM_MISMATCH',
    );
    assert.throws(
      () => value.service.progress({
        bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'progress-many', protocolVersion: 1,
        taskId: claim.task.task_id, claimToken: claim.lease.claim_token,
        events: Array.from({ length: BRIDGE_MAX_EVENTS + 1 }, (_, index) => ({ event_id: String(index) })),
      }),
      (error) => error?.code === 'BRIDGE_LIMIT_EXCEEDED',
    );
    assert.throws(
      () => value.service.progress({
        bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'progress-one-large', protocolVersion: 1,
        taskId: claim.task.task_id, claimToken: claim.lease.claim_token,
        events: [{ event_id: 'one-large', text: 'x'.repeat(BRIDGE_MAX_EVENT_BYTES) }],
      }),
      (error) => error?.code === 'BRIDGE_LIMIT_EXCEEDED' && error.status === 413,
    );
    assert.throws(
      () => value.service.progress({
        bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'progress-large', protocolVersion: 1,
        taskId: claim.task.task_id, claimToken: claim.lease.claim_token,
        events: [{ event_id: 'large', text: 'x'.repeat(BRIDGE_MAX_EVENTS_BYTES) }],
      }),
      (error) => error?.code === 'BRIDGE_LIMIT_EXCEEDED',
    );
  } finally {
    value.close();
  }
});

test('heartbeat renews and transactionally delivers only non-sensitive interaction responses', () => {
  const value = fixture();
  try {
    register(value);
    createTask(value, 'task-interaction');
    const claim = value.service.pull({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'pull-interaction', protocolVersion: 1,
    }).response.claims[0];
    const interaction = value.service.createInteraction({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'interaction-create', protocolVersion: 1,
      taskId: claim.task.task_id, claimToken: claim.lease.claim_token,
      interaction: { interaction_id: 'interaction-1', kind: 'question', schema: {} },
    }).response.interaction;
    value.interactionRepository.answer(interaction.interaction_id, {
      response_id: 'response-1', answers: { answer: 'yes' }, answered_by: 'admin',
    });

    const heartbeat = value.service.heartbeat({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'heartbeat-1', protocolVersion: 1,
      taskId: claim.task.task_id, claimToken: claim.lease.claim_token,
    });
    assert.equal(heartbeat.response.interactions.length, 1);
    assert.equal(heartbeat.response.interactions[0].interaction_id, interaction.interaction_id);
    assert.equal(value.interactionRepository.get(interaction.interaction_id).status, 'delivered');

    const replay = value.service.heartbeat({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'heartbeat-1', protocolVersion: 1,
      taskId: claim.task.task_id, claimToken: claim.lease.claim_token,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.response, heartbeat.response);

    const consumed = value.service.consumeInteraction({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'interaction-consume', protocolVersion: 1,
      taskId: claim.task.task_id, claimToken: claim.lease.claim_token, interactionId: interaction.interaction_id,
    });
    assert.equal(consumed.response.interaction.status, 'consumed');
    assert.equal(consumed.response.task.status, 'running');

    assert.throws(
      () => value.service.createInteraction({
        bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'credential-create', protocolVersion: 1,
        taskId: claim.task.task_id, claimToken: claim.lease.claim_token,
        interaction: { interaction_id: 'credential-1', kind: 'credential', schema: {} },
      }),
      (error) => error?.code === 'BRIDGE_INTERACTION_FORBIDDEN',
    );
  } finally {
    value.close();
  }
});

test('heartbeat reports cancellation only to the bridge that held the claim', () => {
  const value = fixture();
  try {
    register(value);
    createTask(value, 'task-cancel');
    const claim = value.service.pull({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'pull-cancel', protocolVersion: 1,
    }).response.claims[0];
    value.taskRepository.cancel(claim.task.task_id, 'admin');

    const heartbeat = value.service.heartbeat({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'heartbeat-cancel', protocolVersion: 1,
      taskId: claim.task.task_id, claimToken: claim.lease.claim_token,
    });
    assert.deepEqual(heartbeat.response.cancellation, { requested: true, state: 'cancelled' });
    assert.equal(heartbeat.response.lease, null);
    assert.throws(
      () => value.service.heartbeat({
        bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'heartbeat-cancel-forged', protocolVersion: 1,
        taskId: claim.task.task_id, claimToken: 'forged',
      }),
      (error) => error?.code === 'CLAIM_MISMATCH',
    );
  } finally {
    value.close();
  }
});

test('revoked bridges and leases expired on the injected clock are rejected', () => {
  const value = fixture();
  try {
    register(value);
    createTask(value, 'task-expiry');
    const claim = value.service.pull({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'pull-expiry', protocolVersion: 1,
    }).response.claims[0];
    value.clock.value = new Date(Date.parse(claim.lease.deadline) + 1);
    assert.throws(
      () => value.service.progress({
        bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'progress-expired', protocolVersion: 1,
        taskId: claim.task.task_id, claimToken: claim.lease.claim_token,
      }),
      (error) => error?.code === 'LEASE_EXPIRED',
    );

    value.workersRegistry.revoke('bridge-1');
    assert.throws(
      () => value.service.pull({
        bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'pull-revoked', protocolVersion: 1,
      }),
      (error) => error?.code === 'BRIDGE_REVOKED' && error.status === 403,
    );
  } finally {
    value.close();
  }
});
test('result kinds are constrained and release only accepts undelivered dispatches', () => {
  const value = fixture();
  try {
    register(value);
    createTask(value, 'task-release');
    createTask(value, 'task-result');
    const claims = value.service.pull({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'pull-terminal', protocolVersion: 1,
    }).response.claims;

    const released = value.service.release({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'release-1', protocolVersion: 1,
      taskId: claims[0].task.task_id, claimToken: claims[0].lease.claim_token,
    });
    assert.equal(released.response.task.status, 'queued');

    value.service.progress({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'start-result', protocolVersion: 1,
      taskId: claims[1].task.task_id, claimToken: claims[1].lease.claim_token,
    });
    assert.throws(
      () => value.service.release({
        bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'release-started', protocolVersion: 1,
        taskId: claims[1].task.task_id, claimToken: claims[1].lease.claim_token,
      }),
      (error) => error?.code === 'TASK_ALREADY_STARTED',
    );
    assert.throws(
      () => value.service.result({
        bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'result-question', protocolVersion: 1,
        taskId: claims[1].task.task_id, claimToken: claims[1].lease.claim_token, kind: 'question',
      }),
      (error) => error?.code === 'BRIDGE_INTERACTION_FORBIDDEN',
    );
    const terminal = value.service.result({
      bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'result-report', protocolVersion: 1,
      taskId: claims[1].task.task_id, claimToken: claims[1].lease.claim_token,
      kind: 'report', result: { summary: 'complete' },
    });
    assert.equal(terminal.response.task.status, 'done');
    assert.equal(terminal.response.task.result_kind, 'report');
    assert.equal(terminal.response.lease, null);
    assert.throws(
      () => value.service.result({
        bridgeId: 'bridge-1', subjectId: 'machine:bridge-1', requestId: 'result-conflict', protocolVersion: 1,
        taskId: claims[1].task.task_id, claimToken: claims[1].lease.claim_token,
        kind: 'failed', result: { error: 'different terminal result' },
      }),
      (error) => error?.code === 'TASK_TERMINAL_CONFLICT' && error.status === 409,
    );
  } finally {
    value.close();
  }
});
