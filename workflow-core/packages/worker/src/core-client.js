// core-client.js - worker-side connection to the Workflow Core: authenticated
// WebSocket with reconnection/backoff, heartbeat per server config, and REST
// claim-polling fallback while the socket is down.
import WebSocket from 'ws';
import { frame } from '@workflow-core/shared';

const DEFAULT_HEARTBEAT_MS = 30_000;
const CLAIM_POLL_MS = 10_000;

export class CoreConnection {
  constructor({
    url, token, workerId, register, log = () => {}, WebSocketImpl = WebSocket, fetchImpl = fetch,
  }) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.workerId = workerId;
    this.register = register;
    this.log = log;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.handlers = new Map();
    this.ws = null;
    this.heartbeatTimer = null;
    this.heartbeatMs = DEFAULT_HEARTBEAT_MS;
    this.fallbackTimer = null;
    this.backoffMs = 500;
    this.closed = false;
  }

  on(type, handler) {
    this.handlers.set(type, handler);
    return this;
  }

  send(type, payload) {
    if (this.closed || !this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) return false;
    this.ws.send(JSON.stringify(frame(type, payload)));
    return true;
  }

  connect() {
    if (this.closed) return;
    const ws = new this.WebSocketImpl(`${this.url.replace(/^http/, 'ws')}/worker`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    this.ws = ws;
    ws.on('open', () => {
      this.backoffMs = 500;
      this.log(`[worker] connected to ${this.url}`);
      this.send('register', { ...this.register, worker_id: this.workerId });
      this.#stopFallback();
    });
    ws.on('message', (data) => {
      let parsed;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      const handler = this.handlers.get(parsed.type);
      if (handler) handler(parsed.payload, parsed);
      else if (parsed.type === 'error') this.log(`[worker] core error: ${parsed.payload?.error ?? 'unknown'}`);
    });
    ws.on('close', () => {
      this.#stopHeartbeat();
      if (this.closed) return;
      this.log(`[worker] connection lost; retrying in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(30_000, this.backoffMs * 2);
      this.#startFallback();
    });
    ws.on('error', () => { /* close handler drives reconnection */ });
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
      if (!this.send('heartbeat', {})) this.#stopHeartbeat();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // While disconnected, fall back to REST claiming exactly like the legacy
  // poll workers; the dispatch handler is reused for claimed tasks.
  #startFallback() {
    if (this.fallbackTimer || this.closed) return;
    const fallback = this.fallbackTimer;
    void fallback;
    this.fallbackTimer = setInterval(async () => {
      if (this.ws?.readyState === this.WebSocketImpl.OPEN) { this.#stopFallback(); return; }
      try {
        const response = await this.fetchImpl(`${this.url}/api/v1/tasks/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ worker_id: this.workerId, selector: this.register.selector ?? null }),
        });
        if (!response.ok) return;
        const body = await response.json();
        if (body.task) this.handlers.get('dispatch')?.(body.task);
      } catch { /* core unreachable; keep polling */ }
    }, CLAIM_POLL_MS);
    this.fallbackTimer.unref();
  }

  #stopFallback() {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  close() {
    this.closed = true;
    this.#stopHeartbeat();
    this.#stopFallback();
    this.ws?.terminate?.();
  }
}
