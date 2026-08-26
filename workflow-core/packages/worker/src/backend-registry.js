import { assertBackendDescriptor } from './backends/contract.js';

export class BackendRegistry {
  constructor({ backends = [], log = () => {} } = {}) {
    this.log = log;
    this.backends = new Map();
    for (const entry of backends) this.register(entry.kind, entry.backend, entry.descriptor);
  }

  register(kind, backend, descriptor = null) {
    const value = descriptor || backend?.describe?.();
    assertBackendDescriptor(value);
    if (value.kind !== kind) throw new TypeError(`backend kind mismatch: ${kind}`);
    if (!backend || typeof backend.run !== 'function') throw new TypeError(`backend ${kind} must implement run()`);
    this.backends.set(kind, { backend, descriptor: { ...value, capabilities: [...value.capabilities] }, healthy: null });
    return this.get(kind);
  }

  get(kind) { const value = this.backends.get(kind); return value ? { ...value, descriptor: { ...value.descriptor } } : null; }
  unregister(kind) {
    const entry = this.backends.get(kind);
    if (!entry) return false;
    this.backends.delete(kind);
    return true;
  }
  list() { return [...this.backends.values()].map((value) => ({ kind: value.descriptor.kind, ...value.descriptor, healthy: value.healthy })); }
  kinds() { return [...this.backends.keys()]; }
  async health(kind = null) {
    const entries = kind ? [this.backends.get(kind)].filter(Boolean) : [...this.backends.values()];
    const result = [];
    for (const entry of entries) {
      try { entry.healthy = await entry.backend.checkHealth?.() ?? { ok: true }; }
      catch (error) { entry.healthy = { ok: false, error: error.message }; }
      result.push({ kind: entry.descriptor.kind, ...entry.healthy });
    }
    return kind ? result[0] ?? null : result;
  }

  async startAll(context = {}) { for (const entry of this.backends.values()) await entry.backend.start?.(context); }
  async dispose() { for (const entry of this.backends.values()) await entry.backend.dispose?.(); }
}
