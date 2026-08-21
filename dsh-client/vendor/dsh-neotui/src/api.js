// api.js - authenticated DeepSeek Harness wire client.
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { AuthRequiredError, AuthSession } from "./auth.js";
import { validateBase } from "./cli.js";

export class ApiError extends Error {
  constructor(error) {
    super(`${error?.code ?? "error"}: ${error?.message ?? JSON.stringify(error)}`);
    this.name = "ApiError";
    this.code = error?.code;
    this.details = error?.details;
    this.status = error?.status;
  }
}

const DEFAULT_BASE = "https://139.155.78.241:8710/dsh";

export class Api {
  constructor({ base = DEFAULT_BASE, auth = new AuthSession(), fetchImpl = fetch, WebSocketImpl = WebSocket, log = () => {}, onFrame = () => {}, onHostFrame = () => {}, onStateChange = () => {}, onAuthRequired = () => {} } = {}) {
    this.base = validateBase(base);
    this.auth = auth;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.log = log;
    this.onFrame = onFrame;
    this.onHostFrame = onHostFrame;
    this.onStateChange = onStateChange;
    this.onAuthRequired = onAuthRequired;
    this.ws = null;
    this.hostWs = null;
    this.muxWs = null;
    this.closed = false;
    this.connected = false;
    this.connectionState = {
      mux: { ws: null, connected: false, retryDelay: 500, timer: null },
      host: { ws: null, connected: false, retryDelay: 500, timer: null },
    };
  }

  loginUrl() {
    const url = new URL(this.base);
    return `${url.protocol}//${url.host}/api/v1/auth/client-login`;
  }

  async login(email, password) {
    if (typeof email !== "string" || email.trim() === "" || typeof password !== "string" || password === "") {
      throw new ApiError({ code: "invalid-credentials", message: "email and password are required" });
    }
    let res;
    try {
      res = await this.fetchImpl(this.loginUrl(), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
    } catch (error) {
      throw new ApiError({ code: "transport", message: `login unreachable: ${error.message}` });
    }
    if (!res.ok) {
      this.auth.clear();
      throw new ApiError({ code: "login-failed", message: `login HTTP ${res.status}`, status: res.status });
    }
    const body = await res.json();
    this.auth.setLogin(body);
    return { expires_at: body.expires_at, account: body.account };
  }

  #headers() {
    return { "content-type": "application/json", authorization: this.auth.authorization() };
  }

  #unauthorized(status) {
    if (status !== 401 && status !== 403) return false;
    this.auth.clear();
    this.closeStreams();
    this.onAuthRequired(status);
    return true;
  }

  async #post(path, body, label) {
    let res;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: "POST", headers: this.#headers(), body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof AuthRequiredError) throw error;
      throw new ApiError({ code: "transport", message: `${label} unreachable: ${error.message}` });
    }
    if (!res.ok) {
      this.#unauthorized(res.status);
      throw new ApiError({ code: res.status === 401 || res.status === 403 ? "auth-required" : "http", message: `${label} HTTP ${res.status}`, status: res.status });
    }
    return res;
  }

  async call(method, payload = {}) {
    const env = { type: "client-request", rpcId: crypto.randomUUID(), method, payload };
    const res = await this.#post(`/api/${method}`, env, method);
    const body = await res.json();
    if (body?.type !== "server-response") throw new ApiError({ code: "protocol", message: "bad envelope" });
    if (!body.result?.ok) throw new ApiError(body.result.error);
    return body.result.value;
  }

  async logicalExport(sessionId, { pageSize = 80 } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new ApiError({ code: "invalid-session", message: "sessionId is required" });
    }
    const events = [];
    let beforeSeq;
    let header = null;
    let projections = null;
    for (;;) {
      const page = await this.call("session.history", {
        sessionId,
        maxMessages: pageSize,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
      if (header === null && page.header !== undefined) header = page.header;
      if (projections === null && page.projections !== undefined) projections = page.projections;
      const batch = Array.isArray(page.events) ? page.events : [];
      events.unshift(...batch);
      if (!page.hasMore) break;
      const next = batch[0]?.event?.seq;
      if (!Number.isSafeInteger(next) || next < 0 || next === beforeSeq) {
        throw new ApiError({ code: "protocol", message: "session.history did not advance its cursor" });
      }
      beforeSeq = next;
    }

    const refs = new Map();
    const visit = (value) => {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else if (value && typeof value === "object") {
        if (typeof value.attachmentId === "string") refs.set(value.attachmentId, value);
        for (const item of Object.values(value)) visit(item);
      }
    };
    visit(events);
    const attachments = [];
    for (const [attachmentId] of [...refs].sort(([a], [b]) => a.localeCompare(b))) {
      const result = await this.call("session.attachment", { sessionId, attachmentId });
      const data = String(result.data ?? "");
      const bytes = Buffer.from(data, "base64");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (attachmentId.startsWith("sha256:") && attachmentId.slice(7) !== sha256) {
        throw new ApiError({ code: "attachment-hash", message: `attachment ${attachmentId} SHA-256 mismatch` });
      }
      attachments.push({ attachmentId, attachment: result.attachment ?? refs.get(attachmentId), bytes: bytes.length, sha256, data });
    }
    return { format: "dsh-logical-session-v1", sessionId, header, projections, events, attachments };
  }

  async respond(rpcId, value) { return this.#respondEnvelope(rpcId, { ok: true, value }); }

  async cancelResponse(rpcId) {
    return this.#respondEnvelope(rpcId, { ok: false, error: { code: "cancelled", message: "cancelled by the TUI user" } });
  }

  async #respondEnvelope(rpcId, result) {
    const res = await this.#post("/api/respond", { type: "client-response", rpcId, result }, "respond");
    const receipt = await res.json();
    if (receipt?.accepted === false) throw new ApiError({ code: "response-rejected", message: receipt.reason ?? "response rejected" });
    return receipt;
  }

  connectMux() { this.#connect(this.wsUrl("events.mux"), "mux"); }
  connectHost() { this.#connect(this.wsUrl("events.host"), "host"); }

  wsUrl(path) { return `${this.base.replace(/^http/, "ws")}/api/${path}`; }

  #connect(url, kind) {
    if (this.closed || !this.auth.authenticated) return;
    const state = this.connectionState[kind];
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    let ws;
    try {
      ws = new this.WebSocketImpl(url, { headers: { Authorization: this.auth.authorization() } });
    } catch (error) {
      if (error instanceof AuthRequiredError) this.onAuthRequired();
      else this.log(`[api] ${kind} stream failed: ${error.message}`);
      return;
    }
    state.ws = ws;
    if (kind === "mux") this.muxWs = ws;
    else this.hostWs = ws;
    this.ws = ws;
    ws.onopen = () => {
      if (state.ws !== ws || this.closed) return;
      state.connected = true;
      state.retryDelay = 500;
      this.log(`[api] ${kind} stream connected`);
      this.#publishConnectionState();
    };
    ws.onmessage = (message) => {
      if (state.ws !== ws || this.closed) return;
      let body;
      try { body = JSON.parse(String(message.data)); } catch { return; }
      if (body?.type !== "server-request") return;
      const frame = body.payload ?? {};
      frame.__rpcId = body.rpcId;
      if (kind === "mux") this.onFrame(frame);
      else this.onHostFrame(frame);
    };
    ws.on?.("unexpected-response", (_request, response) => {
      if (this.#unauthorized(response.statusCode)) try { ws.terminate(); } catch {}
    });
    ws.onclose = () => {
      if (state.ws !== ws) return;
      state.connected = false;
      state.ws = null;
      this.#publishConnectionState();
      if (this.closed || !this.auth.authenticated) return;
      const delay = state.retryDelay;
      this.log(`[api] ${kind} stream closed, reconnecting in ${delay}ms`);
      state.timer = setTimeout(() => { state.timer = null; this.#connect(url, kind); }, delay);
      state.retryDelay = Math.min(Math.max(500, delay * 2), 15000);
    };
    ws.onerror = () => {};
  }

  #publishConnectionState() {
    const mux = this.connectionState.mux.connected;
    const host = this.connectionState.host.connected;
    this.connected = mux;
    this.onStateChange(mux && host ? "connected" : (mux || host ? "degraded" : "disconnected"));
  }

  async rpcCall(method, payload = {}) {
    const env = { type: "client-request", rpcId: crypto.randomUUID(), method, payload: { args: payload ?? {} } };
    const res = await this.#post(`/api/${method}`, env, "rpc");
    const body = await res.json();
    if (body?.type !== "server-response") throw new ApiError({ code: "protocol", message: "bad rpc envelope" });
    if (!body.result?.ok) throw new ApiError(body.result.error);
    return body.result.value;
  }

  refreshMux() {
    if (this.closed || !this.auth.authenticated) return;
    const state = this.connectionState.mux;
    state.retryDelay = 0;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.ws) try { state.ws.close(); } catch {}
    else this.#connect(this.wsUrl("events.mux"), "mux");
  }

  get muxConnected() { return this.connectionState.mux.connected; }
  get hostConnected() { return this.connectionState.host.connected; }

  closeStreams() {
    for (const state of Object.values(this.connectionState)) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.connected = false;
      try { state.ws?.close(); } catch {}
      state.ws = null;
    }
    this.connected = false;
    this.#publishConnectionState();
  }

  close() {
    this.closed = true;
    this.closeStreams();
    this.auth.clear();
  }
}

export { AuthRequiredError, AuthSession } from "./auth.js";
