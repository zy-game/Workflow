// protocol.js - wire contract between Workflow Core and workers.
// Envelope: { type, id, ts, payload }. Every frame validates against this module.

export const PROTOCOL_VERSION = 4;

export const INTERACTION_KINDS = Object.freeze([
  'question', 'approval', 'credential', 'file_select', 'control',
]);

export const INTERACTION_STATUSES = Object.freeze([
  'pending', 'answered', 'delivered', 'consumed', 'expired', 'cancelled',
]);

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
  'register', 'heartbeat', 'status', 'progress', 'session_event',
  'interaction_required', 'interaction_resolved', 'task_done', 'task_failed',
  'error',
]);

export const CORE_FRAME_TYPES = Object.freeze([
  'config', 'dispatch', 'inject', 'cancel', 'pause', 'resume',
  'interaction_response', 'interaction_cancel', 'ping', 'ack', 'error',
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

export function validateInteractionRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('interaction request must be an object');
  for (const field of ['interaction_id', 'task_id', 'kind']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new TypeError(`${field} is required`);
  }
  if (!INTERACTION_KINDS.includes(value.kind)) throw new TypeError(`unsupported interaction kind: ${value.kind}`);
  if (value.expires_at !== undefined && (typeof value.expires_at !== 'string' || Number.isNaN(Date.parse(value.expires_at)))) {
    throw new TypeError('expires_at must be an ISO timestamp');
  }
  if (value.schema !== undefined && (!value.schema || typeof value.schema !== 'object' || Array.isArray(value.schema))) {
    throw new TypeError('interaction schema must be an object');
  }
  return value;
}

export function validateInteractionResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('interaction response must be an object');
  for (const field of ['interaction_id', 'response_id']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new TypeError(`${field} is required`);
  }
  if (value.answers !== undefined && (value.answers === null || typeof value.answers !== 'object' || Array.isArray(value.answers))) {
    throw new TypeError('answers must be an object');
  }
  return value;
}

export function validatePriority(priority) {
  const value = Number(priority);
  if (!Number.isInteger(value) || value < PRIORITY_MIN || value > PRIORITY_MAX) {
    throw new TypeError(`priority must be an integer ${PRIORITY_MIN}-${PRIORITY_MAX}`);
  }
  return value;
}
