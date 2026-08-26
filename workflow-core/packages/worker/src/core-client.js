// core-client.js - authenticated Worker WebSocket with reconnect and durable delivery.
import WebSocket from 'ws';
import { frame, parseFrame } from '@workflow-core/shared';
import { RunStore } from './run-store.js';

const DEFAULT_HEARTBEAT_MS = 30_000;
const RETRY_MAX_MS = 30_000;
const TRANSIENT_TYPES = new Set([
  'status', 'progress', 'session_event', 'interaction_required',
  'interaction_resolved', 'task_done', 'task_failed', 'error',
]);

export class CoreConnection {
  constructor({
    url, token, workerId, register, log = () => {}, WebSocketImpl = WebSocket,
    runStore = null, stateDir = null,
  }) {
    if (!url || !token || !workerId) throw new TypeError('url, token and workerId are required');
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.workerId = workerId;
    this.register = register ?? {};
    this.log = log;
    this.WebSocketImpl = WebSocketImpl;
    this.runStore = runStore || (stateDir ? new RunStore({ dataDir: stateDir }) : null);
    this.handlers = new Map();
    this.ackHandlers = new Set();
    this.ws = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.heartbeatMs = DEFAULT_HEARTBEAT_MS;
    this.backoffMs = 500;
    this.closed = false;
    this.flushInProgress = false;
  }

  on(type, handler) {
    this.handlers.set(type, handler);
    return this;
  }

  onAck(handler) {
    if (typeof handler !== 'function') throw new TypeError('ack handler must be a function');
    this.ackHandlers.add(handler);
    return () => this.ackHandlers.delete(handler);
  }

  isOpen() {
    return !this.closed && this.ws?.readyState === this.WebSocketImpl.OPEN;
  }

  send(type, payload, { durable = TRANSIENT_TYPES.has(type), id = crypto.randomUUID() } = {}) {
    if (this.closed) return false;
    const value = frame(type, payload, id);
    if (durable && this.runStore) {
      try { this.runStore.enqueue({ frameId: value.id, type, payload: value.payload }); }
      catch (error) {
        this.log(`[worker] outbound frame rejected: ${error.message}`);
        return false;
      }
    }
    if (!this.isOpen()) return false;
    try {
      this.ws.send(JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  connect() {
    if (this.closed || this.ws) return;
    const ws = new this.WebSocketImpl(`${this.url.replace(/^http/, 'ws')}/worker`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    this.ws = ws;
    ws.on('open', () => {
      this.backoffMs = 500;
      this.log(`[worker] connected to ${this.url}`);
      this.send('register', { ...this.register, worker_id: this.workerId }, { durable: false });
      this.#flushOutbox();
    });
    ws.on('message', (data) => {
      let parsed;
      try { parsed = parseFrame(JSON.parse(data.toString())); } catch { parsed = null; }
      if (!parsed) return;
      const handler = this.handlers.get(parsed.type);
      if (parsed.type === 'ack') {
        const frameId = parsed.payload?.frame_id;
        if (frameId && this.runStore && parsed.payload?.accepted !== false) {
          this.runStore.removeFrame(frameId);
          for (const handler of this.ackHandlers) handler(frameId, parsed.payload);
        }
      }
      if (handler) Promise.resolve(handler(parsed.payload, parsed)).catch((error) => this.log(`[worker] frame ${parsed.type} failed: ${error.message}`));
      else if (parsed.type === 'error') this.log(`[worker] core error: ${parsed.payload?.error ?? 'unknown'}`);
    });
    ws.on('close', () => {
      this.ws = null;
      this.#stopHeartbeat();
      if (this.closed) return;
      this.log(`[worker] connection lost; retrying in ${this.backoffMs}ms`);
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, this.backoffMs);
      this.reconnectTimer.unref?.();
      this.backoffMs = Math.min(RETRY_MAX_MS, this.backoffMs * 2);
    });
    ws.on('error', () => { /* close drives reconnect */ });
  }

  applyConfig(config) {
    if (Number.isInteger(config?.heartbeat_interval_ms) && config.heartbeat_interval_ms > 0) {
      this.heartbeatMs = config.heartbeat_interval_ms;
    }
    this.#startHeartbeat();
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.send('heartbeat', {}, { durable: false })) this.#stopHeartbeat();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async #flushOutbox() {
    if (this.flushInProgress || !this.runStore || !this.isOpen()) return;
    this.flushInProgress = true;
    try {
      for (const pending of this.runStore.pendingFrames()) {
        if (!this.isOpen()) break;
        const value = frame(pending.type, pending.payload, pending.frameId);
        try {
          this.ws.send(JSON.stringify(value));
        } catch { break; }
      }
    } finally {
      this.flushInProgress = false;
    }
  }

  close() {
    this.closed = true;
    this.#stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.terminate?.();
    this.ws = null;
  }
}
