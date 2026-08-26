export const BACKEND_EVENTS = Object.freeze([
  'session_started', 'assistant_delta', 'assistant_message', 'tool_started',
  'tool_updated', 'tool_finished', 'progress', 'interaction_required',
  'interaction_resolved', 'completed', 'failed',
]);

export class BackendContract {
  describe() { throw new Error('backend describe() is required'); }
  async checkHealth() { return { ok: true }; }
  async start() {}
  async run() { throw new Error('backend run() is required'); }
  async resume(options) { return this.run(options); }
  async inject() { return false; }
  async cancel() { return false; }
  async resolveInteraction() { return false; }
  async dispose() {}
}

export function assertBackendDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') throw new TypeError('backend descriptor must be an object');
  if (typeof descriptor.kind !== 'string' || !descriptor.kind) throw new TypeError('backend kind is required');
  if (!Array.isArray(descriptor.capabilities)) throw new TypeError('backend capabilities must be an array');
  return descriptor;
}
