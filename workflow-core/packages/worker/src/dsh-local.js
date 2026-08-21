// dsh-local.js - lifecycle and wire access for the worker's local DSH.
// The daemon spawns `dsh web` on a loopback port and drives it through the
// same HTTP protocol the TUI uses. Tests inject a fake endpoint instead of a
// real process. Session events are streamed by paging session.history - a
// local-process poll is effectively realtime and avoids a second WS client.
// Approvals are the exception: DSH pushes approval/requested frames only on
// the events.mux websocket, so the worker keeps one mux connection open.
import crypto from 'node:crypto';
import { applyDshModel } from '@workflow-core/shared';
import WebSocket from 'ws';

export const PROMPT_POLL_MS = 2000;

export class DshLocal {
  constructor({ baseUrl, spawnImpl = null, log = () => {}, fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
    this.baseUrl = baseUrl?.replace(/\/$/, '') ?? null;
    this.spawnImpl = spawnImpl;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.child = null;
    this.modelEntries = [];
    this.approvalWs = null;
    this.approvalHandlers = null;
    this.approvalReconnectMs = 500;
    this.approvalClosed = false;
  }

  get endpoint() {
    return this.baseUrl;
  }

  async #ensureReady() {
    if (!this.baseUrl) throw new Error('local DSH endpoint is not configured');
  }

  async start() {
    if (this.child || !this.spawnImpl) {
      await this.#ensureReady();
      return;
    }
    const { port, child } = await this.spawnImpl();
    this.child = child;
    this.baseUrl = `http://127.0.0.1:${port}`;
    child.on('exit', (code) => {
      this.log(`[dsh] local DSH exited (code ${code})`);
      this.child = null;
    });
    await this.#waitReady();
  }

  async #waitReady(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this.call('host.describe', {});
        this.log(`[dsh] local DSH ready at ${this.baseUrl}`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw new Error('local DSH did not become ready in time');
  }

  async stop({ timeoutMs = 5_000 } = {}) {
    this.closeApprovals();
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
  }

  async call(method, payload = {}) {
    await this.#ensureReady();
    const response = await this.fetchImpl(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    });
    if (!response.ok) {
      const error = new Error(`DSH ${method} HTTP ${response.status}`);
      error.code = 'DSH_HTTP_ERROR';
      error.method = method;
      throw error;
    }
    const body = await response.json();
    if (body?.type !== 'server-response' || !body.result?.ok) {
      const error = new Error(`DSH ${method}: ${body.result?.error?.message ?? 'request failed'}`);
      error.code = body.result?.error?.code ?? 'DSH_REQUEST_FAILED';
      error.method = method;
      throw error;
    }
    return body.result.value;
  }

  async applyModels(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      this.modelEntries = [];
      return [];
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      await applyDshModel(this, entries[index], { activate: index === 0 });
    }
    this.modelEntries = entries;
    return entries;
  }

  // DSH pushes pending approvals as {rpcId, payload:{type:'approval/requested',
  // sessionId, approvalId, toolName, reason?}} frames on the events.mux
  // websocket (replayed on connect) and announces decisions as
  // approval/resolved. One connection per local DSH process serves every task.
  connectApprovals({ onWaiting, onResolved } = {}) {
    this.approvalHandlers = { onWaiting, onResolved };
    this.approvalClosed = false;
    this.#openApprovalSocket();
  }

  closeApprovals() {
    this.approvalClosed = true;
    if (this.approvalWs) {
      const socket = this.approvalWs;
      this.approvalWs = null;
      try { socket.close(); } catch { /* already closing */ }
      try { socket.terminate(); } catch { /* already closed */ }
    }
  }

  #openApprovalSocket() {
    if (this.approvalClosed || !this.baseUrl || !this.approvalHandlers) return;
    const ws = new this.WebSocketImpl(`${this.baseUrl.replace(/^http/, 'ws')}/api/events.mux`);
    this.approvalWs = ws;
    ws.on('open', () => {
      this.approvalReconnectMs = 500;
    });
    ws.on('message', (data) => {
      let parsed;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      const payload = parsed?.payload ?? parsed;
      if (payload?.type === 'approval/requested') {
        this.approvalHandlers.onWaiting?.(payload, parsed.rpcId ?? null);
      } else if (payload?.type === 'approval/resolved') {
        this.approvalHandlers.onResolved?.(payload);
      }
    });
    ws.on('close', () => {
      if (this.approvalClosed || this.approvalWs !== ws) return;
      this.approvalWs = null;
      setTimeout(() => this.#openApprovalSocket(), this.approvalReconnectMs);
      this.approvalReconnectMs = Math.min(15_000, this.approvalReconnectMs * 2);
    });
    ws.on('error', () => { /* close handler drives reconnection */ });
  }

  // /api/respond expects a client-RESPONSE envelope echoing the pending
  // approval's rpcId; outcome must be 'allowed-once' or 'rejected'.
  async respondApproval({ rpcId, sessionId, approvalId, outcome }) {
    if (!this.baseUrl) throw new Error('local DSH endpoint is not configured');
    if (!['allowed-once', 'rejected'].includes(outcome)) {
      throw new TypeError(`invalid approval outcome: ${outcome}`);
    }
    const response = await this.fetchImpl(`${this.baseUrl}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId,
        result: { ok: true, value: { sessionId, approvalId, outcome } },
      }),
    });
    if (!response.ok) throw new Error(`DSH respond HTTP ${response.status}`);
    return response.json().catch(() => ({}));
  }

  async createSession({ workspace, title = null }) {
    return this.call('session.create', { cwd: workspace, ...(title ? { title } : {}) });
  }

  async prompt(sessionId, content, { mode = 'queue' } = {}) {
    return this.call('session.prompt', {
      sessionId, mode,
      content: [{ type: 'text', text: content }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  async cancel(sessionId) {
    return this.call('session.cancel', { sessionId });
  }

  // Pages new events since lastSeq and normalizes them into session_event
  // payloads for the core log.
  async pollEvents(sessionId, lastSeq) {
    const pages = [];
    let beforeSeq;
    let header = null;
    let highest = lastSeq;

    for (;;) {
      const page = await this.call('session.history', {
        sessionId,
        maxMessages: 200,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
      if (header === null && page.header !== undefined) header = page.header;
      const batch = Array.isArray(page.events) ? page.events : [];
      const normalized = [];
      let reachedCursor = false;
      for (const entry of batch) {
        const seq = entry?.event?.seq;
        if (!Number.isSafeInteger(seq)) continue;
        if (seq <= lastSeq) {
          reachedCursor = true;
          continue;
        }
        highest = Math.max(highest, seq);
        normalized.push({ kind: classifyEvent(entry.event), seq, event: entry.event });
      }
      pages.unshift(normalized);
      if (reachedCursor || page.hasMore !== true) break;
      const next = batch[0]?.event?.seq;
      if (!Number.isSafeInteger(next) || next === beforeSeq) {
        throw new Error('session.history cursor did not advance');
      }
      beforeSeq = next;
    }

    const events = pages.flat().sort((left, right) => left.seq - right.seq);
    return { lastSeq: highest, events, hasMore: false, header };
  }

  async exportSession(sessionId) {
    const events = [];
    let beforeSeq;
    let header = null;
    let projections = null;
    for (;;) {
      const page = await this.call('session.history', {
        sessionId, maxMessages: 100, ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
      if (header === null && page.header !== undefined) header = page.header;
      if (projections === null && page.projections !== undefined) projections = page.projections;
      const batch = Array.isArray(page.events) ? page.events : [];
      events.unshift(...batch);
      if (!page.hasMore) break;
      const next = batch[0]?.event?.seq;
      if (!Number.isSafeInteger(next) || next === beforeSeq) throw new Error('session.history cursor did not advance');
      beforeSeq = next;
    }
    return { format: 'dsh-logical-session-v1', sessionId, header, projections, events };
  }
}

function classifyEvent(event) {
  const type = event?.type ?? event?.event ?? 'unknown';
  if (String(type).startsWith('tool/')) return 'tool';
  if (String(type).startsWith('assistant/')) return 'assistant';
  if (String(type).startsWith('user/')) return 'user';
  return 'other';
}
