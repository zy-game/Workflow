// protocol.js - wire contract between Workflow Core and workers.
// Envelope: { type, id, ts, payload }. Every frame validates against this module.

export const PROTOCOL_VERSION = 1;

export const TASK_STATUSES = Object.freeze([
  'queued', 'dispatched', 'running', 'done', 'failed', 'blocked', 'awaiting_input', 'cancelled',
]);

// done kinds map onto terminal/holding statuses in the task repository.
export const TASK_RESULT_KINDS = Object.freeze(['done', 'failed', 'blocked', 'question', 'report']);

export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 9;
export const DEFAULT_PRIORITY = 5;

// worker -> core
export const WORKER_FRAME_TYPES = Object.freeze([
  'register', 'heartbeat', 'progress', 'session_event', 'task_done',
  'models_ack', 'capabilities_update', 'approval_request', 'error',
]);

// core -> worker
export const CORE_FRAME_TYPES = Object.freeze([
  'dispatch', 'cancel', 'inject', 'models', 'config', 'ping', 'approval_result', 'error',
]);

const FRAME_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function frame(type, payload = {}, id = crypto.randomUUID()) {
  if (typeof type !== 'string' || !FRAME_TYPE_PATTERN.test(type)) {
    throw new TypeError(`invalid frame type: ${type}`);
  }
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new TypeError(`invalid frame id: ${id}`);
  }
  return { type, id, ts: new Date().toISOString(), payload };
}

export function parseFrame(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { type, id, ts, payload } = value;
  if (typeof type !== 'string' || !FRAME_TYPE_PATTERN.test(type)) return null;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  if (ts !== undefined && (typeof ts !== 'string' || Number.isNaN(Date.parse(ts)))) return null;
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) return null;
  return { type, id, ts: ts ?? null, payload: payload ?? {} };
}

export function isWorkerFrame(frameValue) {
  return WORKER_FRAME_TYPES.includes(frameValue?.type);
}

export function isCoreFrame(frameValue) {
  return CORE_FRAME_TYPES.includes(frameValue?.type);
}

export function modelPushEntry({ provider, model, key, baseUrl, priority }) {
  if (typeof provider !== 'string' || !provider) throw new TypeError('provider must be a non-empty string');
  if (typeof model !== 'string' || !model) throw new TypeError('model must be a non-empty string');
  if (typeof key !== 'string' || !key) throw new TypeError('key must be a non-empty string');
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) throw new TypeError('baseUrl must be an http(s) URL');
  const priorityValue = Number(priority);
  if (!Number.isInteger(priorityValue) || priorityValue < PRIORITY_MIN || priorityValue > PRIORITY_MAX) {
    throw new TypeError(`priority must be an integer ${PRIORITY_MIN}-${PRIORITY_MAX}`);
  }
  return { provider, model, key, baseUrl, priority: priorityValue };
}

export function validatePriority(priority) {
  const value = Number(priority);
  if (!Number.isInteger(value) || value < PRIORITY_MIN || value > PRIORITY_MAX) {
    throw new TypeError(`priority must be an integer ${PRIORITY_MIN}-${PRIORITY_MAX}`);
  }
  return value;
}
