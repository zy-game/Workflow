import crypto from 'node:crypto';

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_MAX_EVENTS = 100;
export const BRIDGE_MAX_EVENT_BYTES = 64 * 1024;
export const BRIDGE_MAX_EVENTS_BYTES = 256 * 1024;
export const BRIDGE_MAX_IDENTIFIER_LENGTH = 128;

const ACTIVE_TASK_STATUSES = new Set(['dispatched', 'running', 'awaiting_input']);
const ALLOWED_INTERACTION_KINDS = new Set(['question', 'approval', 'control']);
const ALLOWED_RESULT_KINDS = new Set(['done', 'report', 'failed', 'blocked']);
const DELIVERABLE_INTERACTION_KINDS = new Set(['question', 'approval', 'control']);

const ERROR_STATUS = Object.freeze({
  BRIDGE_OWNER_MISMATCH: 403,
  CLAIM_MISMATCH: 409,
  LEASE_EXPIRED: 409,
  TASK_NOT_FOUND: 404,
  TASK_NOT_ACTIVE: 409,
  TASK_ALREADY_STARTED: 409,
  BRIDGE_REQUEST_CONFLICT: 409,
  BRIDGE_NOT_REGISTERED: 409,
  BRIDGE_REVOKED: 403,
  BRIDGE_PROJECT_FORBIDDEN: 403,
  BRIDGE_PROTOCOL_UNSUPPORTED: 426,
  BRIDGE_LIMIT_EXCEEDED: 413,
  BRIDGE_INTERACTION_FORBIDDEN: 403,
  TASK_TERMINAL_CONFLICT: 409,
});

export class BridgeServiceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BridgeServiceError';
    this.code = code;
    this.status = ERROR_STATUS[code] ?? 400;
    if (details !== null) this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new BridgeServiceError(code, message, details);
}

function requireString(value, name, maxLength = BRIDGE_MAX_IDENTIFIER_LENGTH) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
  if (value.length > maxLength) throw new TypeError(`${name} exceeds the ${maxLength} character limit`);
  return value;
}

function normalizeProtocolVersion(value) {
  const version = Number(value);
  if (version !== BRIDGE_PROTOCOL_VERSION) {
    fail('BRIDGE_PROTOCOL_UNSUPPORTED', `bridge protocol version ${value ?? 'missing'} is unsupported`, {
      supported_versions: [BRIDGE_PROTOCOL_VERSION],
    });
  }
  return version;
}

function normalizeProjectIds(projects, name) {
  if (!Array.isArray(projects)) throw new TypeError(`${name} must be an array`);
  return [...new Set(projects.map((project) => {
    const id = typeof project === 'string' ? project : project?.project_id;
    if (typeof id !== 'string' || !id) throw new TypeError(`${name} entries must identify a project`);
    return id;
  }))];
}

function scopedProjects(tokenProjects, requestedProjects, requestedWasProvided) {
  const allowed = normalizeProjectIds(tokenProjects ?? [], 'tokenProjects');
  const requested = requestedWasProvided
    ? normalizeProjectIds(requestedProjects, 'metadata.projects')
    : allowed;
  if (allowed.includes('*')) return requested;
  const forbidden = requested.filter((projectId) => !allowed.includes(projectId));
  if (forbidden.length) {
    fail('BRIDGE_PROJECT_FORBIDDEN', `project is not permitted by bridge token: ${forbidden[0]}`, {
      project_id: forbidden[0],
    });
  }
  return requested;
}

function leaseFor(task) {
  if (!task?.claim_token || !task?.lease_deadline) return null;
  return { claim_token: task.claim_token, deadline: task.lease_deadline };
}

function taskResponse(task) {
  return { task, lease: leaseFor(task) };
}

function encodedSize(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail('BRIDGE_LIMIT_EXCEEDED', 'events must be JSON serializable');
  }
  if (encoded === undefined) fail('BRIDGE_LIMIT_EXCEEDED', 'events must be JSON serializable');
  return Buffer.byteLength(encoded, 'utf8');
}

function validateEvents(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  if (events.length > BRIDGE_MAX_EVENTS) {
    fail('BRIDGE_LIMIT_EXCEEDED', `events exceed the ${BRIDGE_MAX_EVENTS} item limit`);
  }
  if (encodedSize(events) > BRIDGE_MAX_EVENTS_BYTES) {
    fail('BRIDGE_LIMIT_EXCEEDED', `events exceed the ${BRIDGE_MAX_EVENTS_BYTES} byte limit`);
  }
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('events entries must be objects');
    }
    if (Object.hasOwn(event, 'event_id')) requireString(event.event_id, 'event.event_id');
    if (encodedSize(event) > BRIDGE_MAX_EVENT_BYTES) {
      fail('BRIDGE_LIMIT_EXCEEDED', `event exceeds the ${BRIDGE_MAX_EVENT_BYTES} byte limit`);
    }
  }
  return events;
}

function normalizeRepositoryError(error) {
  if (error?.code && ERROR_STATUS[error.code] && !error.status) error.status = ERROR_STATUS[error.code];
  return error;
}

export function createBridgeService({
  bridgeRequestsRepository,
  workersRegistry,
  taskRepository,
  interactionRepository,
  now = () => new Date(),
  log = () => {},
} = {}) {
  if (!bridgeRequestsRepository) throw new TypeError('bridgeRequestsRepository is required');
  if (!workersRegistry) throw new TypeError('workersRegistry is required');
  if (!taskRepository) throw new TypeError('taskRepository is required');
  if (!interactionRepository) throw new TypeError('interactionRepository is required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof log !== 'function') throw new TypeError('log must be a function');

  function serverTime() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('now must return a valid date');
    return date.toISOString();
  }

  function response(fields = {}) {
    return {
      ok: true,
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      server_time: serverTime(),
      ...fields,
    };
  }

  function requireIdentity({ bridgeId, subjectId }) {
    requireString(bridgeId, 'bridgeId');
    requireString(subjectId, 'subjectId');
  }

  function registeredBridge({ bridgeId, subjectId }) {
    requireIdentity({ bridgeId, subjectId });
    const worker = workersRegistry.get(bridgeId);
    if (!worker || worker.transport !== 'pull') fail('BRIDGE_NOT_REGISTERED', 'bridge is not registered');
    if (worker.subject_id !== subjectId) fail('BRIDGE_OWNER_MISMATCH', 'bridge belongs to another subject');
    if (worker.revoked || workersRegistry.isRevoked(bridgeId)) fail('BRIDGE_REVOKED', 'bridge has been revoked');
    if (worker.bridge_protocol_version !== BRIDGE_PROTOCOL_VERSION) {
      fail('BRIDGE_PROTOCOL_UNSUPPORTED', 'registered bridge protocol is unsupported');
    }
    return worker;
  }

  function execute({ bridgeId, requestId, operation, taskId = null, payload }, mutation) {
    requireString(requestId, 'requestId');
    try {
      return bridgeRequestsRepository.execute(
        { bridgeId, requestId, operation, taskId, payload },
        () => ({ status: 200, response: mutation() }),
      );
    } catch (error) {
      throw normalizeRepositoryError(error);
    }
  }

  function lastClaim(taskId) {
    const events = taskRepository.events(taskId, { limit: 2000 });
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === 'claimed') return events[index].payload ?? null;
    }
    return null;
  }

  function claimTokenHash(claimToken) {
    return crypto.createHash('sha256').update(claimToken).digest('hex');
  }

  function requireCancelledClaim({ bridgeId, taskId, claimToken }) {
    requireString(claimToken, 'claimToken');
    const claim = lastClaim(taskId);
    if (claim?.worker_id !== bridgeId) fail('BRIDGE_OWNER_MISMATCH', 'task belongs to another bridge');
    if (!claim.claim_token_hash || claim.claim_token_hash !== claimTokenHash(claimToken)) {
      fail('CLAIM_MISMATCH', 'claim token mismatch');
    }
  }

  function requireOwnedLiveTask({ bridgeId, taskId, claimToken }) {
    requireString(taskId, 'taskId');
    const task = taskRepository.get(taskId);
    if (!task) fail('TASK_NOT_FOUND', 'task does not exist');
    if (task.claim_worker_id !== bridgeId) fail('BRIDGE_OWNER_MISMATCH', 'task belongs to another bridge');
    if (!claimToken || claimToken !== task.claim_token) fail('CLAIM_MISMATCH', 'claim token mismatch');
    if (!ACTIVE_TASK_STATUSES.has(task.status)) {
      fail('TASK_NOT_ACTIVE', `task is not active (status ${task.status})`);
    }
    if (task.lease_deadline && task.lease_deadline <= serverTime()) {
      fail('LEASE_EXPIRED', 'lease expired');
    }
    return task;
  }

  function register({
    bridgeId, subjectId, tokenProjects = [], requestId, protocolVersion, metadata = {},
  } = {}) {
    requireIdentity({ bridgeId, subjectId });
    normalizeProtocolVersion(protocolVersion);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('metadata must be an object');
    }
    const existing = workersRegistry.get(bridgeId);
    if (existing && existing.subject_id !== subjectId) {
      fail('BRIDGE_OWNER_MISMATCH', 'bridge belongs to another subject');
    }
    const projects = scopedProjects(tokenProjects, metadata.projects, Object.hasOwn(metadata, 'projects'));
    const payload = { protocol_version: BRIDGE_PROTOCOL_VERSION, subject_id: subjectId, token_projects: tokenProjects, metadata };
    return execute({ bridgeId, requestId, operation: 'register', payload }, () => {
      const worker = workersRegistry.register({
        worker_id: bridgeId,
        subject_id: subjectId,
        machine: metadata.machine ?? null,
        capabilities: metadata.capabilities ?? [],
        selector: metadata.selector ?? {},
        projects,
        backends: metadata.backends ?? [],
        state: metadata.state ?? 'running',
        config_revision: metadata.config_revision ?? 0,
        max_concurrency: metadata.max_concurrency ?? 1,
        version: metadata.version ?? null,
        transport: 'pull',
        bridge_protocol_version: BRIDGE_PROTOCOL_VERSION,
      });
      return response({ worker });
    });
  }

  function pull({ bridgeId, subjectId, requestId, protocolVersion, payload = {} } = {}) {
    normalizeProtocolVersion(protocolVersion);
    const worker = registeredBridge({ bridgeId, subjectId });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('payload must be an object');
    return execute({ bridgeId, requestId, operation: 'pull', payload }, () => {
      if (!workersRegistry.heartbeat(bridgeId, { state: payload.state ?? null, pulled: true })) {
        fail('BRIDGE_NOT_REGISTERED', 'bridge is not registered');
      }
      const current = workersRegistry.get(bridgeId) ?? worker;
      const claims = taskRepository.activeForWorker(bridgeId).map((task) => ({
        ...taskResponse(task),
        resumed: true,
      }));
      if (current.state === 'running') {
        while (claims.length < current.max_concurrency) {
          const task = taskRepository.claim({
            worker_id: bridgeId,
            selector: current.selector,
            project_ids: current.projects,
            capabilities: current.capabilities,
            backends: current.backends,
          });
          if (!task) break;
          claims.push({ ...taskResponse(task), resumed: false });
        }
      }
      return response({ claims });
    });
  }

  function heartbeat({
    bridgeId, subjectId, requestId, protocolVersion, taskId, claimToken, payload = {},
  } = {}) {
    normalizeProtocolVersion(protocolVersion);
    registeredBridge({ bridgeId, subjectId });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('payload must be an object');
    return execute({ bridgeId, requestId, operation: 'heartbeat', taskId, payload: { claim_token: claimToken, ...payload } }, () => {
      if (!workersRegistry.heartbeat(bridgeId, { state: payload.state ?? null })) {
        fail('BRIDGE_NOT_REGISTERED', 'bridge is not registered');
      }
      const current = taskRepository.get(taskId);
      if (!current) fail('TASK_NOT_FOUND', 'task does not exist');
      if (current.status === 'cancelled') {
        requireCancelledClaim({ bridgeId, taskId, claimToken });
        return response({ task: current, lease: null, cancellation: { requested: true, state: 'cancelled' }, interactions: [] });
      }
      requireOwnedLiveTask({ bridgeId, taskId, claimToken });
      const task = taskRepository.renew(taskId, claimToken);
      const interactions = [];
      for (const interaction of interactionRepository.pendingDelivery(bridgeId)) {
        if (interaction.task_id !== taskId || !DELIVERABLE_INTERACTION_KINDS.has(interaction.kind)) continue;
        interactions.push({ interaction_id: interaction.interaction_id, response: interaction.response });
        interactionRepository.markDelivered(interaction.interaction_id);
      }
      return response({ ...taskResponse(task), cancellation: null, interactions });
    });
  }

  function progress({
    bridgeId, subjectId, requestId, protocolVersion, taskId, claimToken,
    note = null, percent = null, events = [],
  } = {}) {
    normalizeProtocolVersion(protocolVersion);
    registeredBridge({ bridgeId, subjectId });
    validateEvents(events);
    const payload = { claim_token: claimToken, note, percent, events };
    return execute({ bridgeId, requestId, operation: 'progress', taskId, payload }, () => {
      requireOwnedLiveTask({ bridgeId, taskId, claimToken });
      const task = taskRepository.progress(taskId, claimToken, { note, percent, events });
      return response(taskResponse(task));
    });
  }

  function createInteraction({
    bridgeId, subjectId, requestId, protocolVersion, taskId, claimToken, interaction,
  } = {}) {
    normalizeProtocolVersion(protocolVersion);
    registeredBridge({ bridgeId, subjectId });
    if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) {
      throw new TypeError('interaction must be an object');
    }
    if (!ALLOWED_INTERACTION_KINDS.has(interaction.kind)) {
      fail('BRIDGE_INTERACTION_FORBIDDEN', `bridge interaction kind is forbidden: ${interaction.kind ?? 'missing'}`);
    }
    const payload = { claim_token: claimToken, interaction };
    return execute({ bridgeId, requestId, operation: 'interaction_create', taskId, payload }, () => {
      const task = requireOwnedLiveTask({ bridgeId, taskId, claimToken });
      const created = interactionRepository.create({
        ...interaction,
        task_id: taskId,
        worker_id: bridgeId,
        backend_kind: task.backend_kind,
        session_ref: interaction.session_ref ?? task.session_ref,
      });
      const nextTask = task.status === 'awaiting_input'
        ? task
        : taskRepository.enterAwaitingInput(taskId, claimToken, created.interaction_id);
      return response({ interaction: created, ...taskResponse(nextTask) });
    });
  }

  function consumeInteraction({
    bridgeId, subjectId, requestId, protocolVersion, taskId, claimToken, interactionId,
  } = {}) {
    normalizeProtocolVersion(protocolVersion);
    registeredBridge({ bridgeId, subjectId });
    requireString(interactionId, 'interactionId');
    const payload = { claim_token: claimToken, interaction_id: interactionId };
    return execute({ bridgeId, requestId, operation: 'interaction_consume', taskId, payload }, () => {
      const task = requireOwnedLiveTask({ bridgeId, taskId, claimToken });
      const current = interactionRepository.get(interactionId);
      if (!current || current.task_id !== taskId) fail('TASK_NOT_FOUND', 'interaction does not belong to task');
      if (!DELIVERABLE_INTERACTION_KINDS.has(current.kind)) {
        fail('BRIDGE_INTERACTION_FORBIDDEN', `bridge interaction kind is forbidden: ${current.kind}`);
      }
      const interaction = interactionRepository.markConsumed(interactionId, bridgeId);
      const nextTask = task.status === 'awaiting_input'
        ? taskRepository.resumeAfterInput(taskId, claimToken, interactionId, bridgeId)
        : taskRepository.get(taskId);
      taskRepository.appendEvent(taskId, 'interaction_consumed', { interaction_id: interactionId }, bridgeId);
      return response({ interaction, ...taskResponse(nextTask) });
    });
  }

  function result({
    bridgeId, subjectId, requestId, protocolVersion, taskId, claimToken,
    kind, result: resultValue = null, sessionRef = null,
  } = {}) {
    normalizeProtocolVersion(protocolVersion);
    registeredBridge({ bridgeId, subjectId });
    if (!ALLOWED_RESULT_KINDS.has(kind)) {
      fail('BRIDGE_INTERACTION_FORBIDDEN', kind === 'question'
        ? 'question results must use interactions'
        : `bridge result kind is unsupported: ${kind ?? 'missing'}`);
    }
    const payload = { claim_token: claimToken, kind, result: resultValue, session_ref: sessionRef };
    return execute({ bridgeId, requestId, operation: 'result', taskId, payload }, () => {
      const current = taskRepository.get(taskId);
      if (!current) fail('TASK_NOT_FOUND', 'task does not exist');
      if (['done', 'failed', 'blocked'].includes(current.status)) {
        fail('TASK_TERMINAL_CONFLICT', `task already has terminal status ${current.status}`);
      }
      requireOwnedLiveTask({ bridgeId, taskId, claimToken });
      const task = taskRepository.done(taskId, claimToken, {
        kind,
        result: resultValue,
        session_ref: sessionRef,
      });
      return response({ task, lease: null });
    });
  }

  function release({ bridgeId, subjectId, requestId, protocolVersion, taskId, claimToken } = {}) {
    normalizeProtocolVersion(protocolVersion);
    registeredBridge({ bridgeId, subjectId });
    const payload = { claim_token: claimToken };
    return execute({ bridgeId, requestId, operation: 'release', taskId, payload }, () => {
      requireOwnedLiveTask({ bridgeId, taskId, claimToken });
      const task = taskRepository.releaseUndeliveredClaim(taskId, claimToken, bridgeId);
      return response({ task, lease: null });
    });
  }

  return {
    register,
    pull,
    heartbeat,
    progress,
    createInteraction,
    consumeInteraction,
    result,
    release,
  };
}
