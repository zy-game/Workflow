// A vendor-neutral adapter for a long-lived local CLI bridge. The bridge is a
// child process that reads one JSON request per line and emits JSON events per
// line. Vendor-specific shims translate those requests to Codex/Claude/Gemini
// without putting their private protocol into Workflow Core.
import { spawn } from 'node:child_process';
const MAX_FRAME_BYTES = 1024 * 1024;

function defaultPrompt(task) {
  const brief = task.brief || {};
  return String(brief.prompt || brief.goal || task.type || '');
}

function writeJson(child, value) {
  if (!child.stdin || child.stdin.destroyed) throw new Error('CLI bridge stdin is closed');
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

const SENSITIVE_ENV_KEY = /(TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

function vendorEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('WFC_')) continue;
    if (SENSITIVE_ENV_KEY.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

export class JsonlCliAdapter {
  constructor({
    command,
    args = [],
    cwd,
    env = {},
    spawnImpl = spawn,
    parseLine = (line) => JSON.parse(line),
    log = () => {},
  } = {}) {
    if (!command || typeof command !== 'string') throw new TypeError('command is required');
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.parseLine = parseLine;
    this.log = log;
    this.processes = new Map();
  }

  #spawn(conversationId, workspace) {
    const child = this.spawnImpl(this.command, [...this.args], {
      cwd: this.cwd || workspace || process.cwd(),
      env: vendorEnv(this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const state = { child, conversationId, buffer: '', pending: null };
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
        state.buffer += String(chunk);
        if (Buffer.byteLength(state.buffer, 'utf8') > MAX_FRAME_BYTES) {
          state.pending?.reject(new Error('Workflow JSONL frame exceeds 1 MiB'));
          state.pending = null;
          state.child.kill?.();
          return;
        }
        let index;
      while ((index = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, index).trim();
        state.buffer = state.buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = this.parseLine(line); } catch (error) { this.log(`[cli-bridge] invalid JSONL: ${error.message}`); continue; }
        this.#handleMessage(state, message);
      }
    });
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => this.log(`[cli-bridge] ${String(chunk).trim()}`));
    const fail = (error) => {
      this.processes.delete(conversationId);
      if (state.pending) { const pending = state.pending; state.pending = null; pending.reject(error); }
    };
    child.once?.('error', fail);
    child.once?.('exit', (code, signal) => {
      fail(new Error(`CLI bridge exited (${code ?? signal ?? 'unknown'})`));
    });
    this.processes.set(conversationId, state);
    return state;
  }

  #handleMessage(state, message) {
    if (!message || typeof message !== 'object') return;
    const pending = state.pending;
    if (message.type === 'session' && pending) {
      const sessionRef = String(message.session_ref || message.sessionRef || '');
      if (sessionRef) pending.sessionRef = sessionRef;
      pending.setSessionRef?.(sessionRef);
    }
        if (message.type === 'interaction_required' && pending) pending.emit?.({ type: 'interaction_required', interaction: message.interaction ?? message.payload ?? message });
        if (message.type === 'event' && pending) pending.emit?.(message.event ?? message.payload ?? message);
    if (message.type === 'progress' && pending) pending.progress?.(message.note ?? null, message.percent ?? null, message.events ?? []);
    if (message.type === 'result' && pending) {
      state.pending = null;
      pending.resolve({ kind: message.kind || 'done', sessionRef: message.session_ref || message.sessionRef || pending.sessionRef, result: message.result ?? {} });
    }
    if (message.type === 'error' && pending) {
      state.pending = null;
      pending.reject(new Error(String(message.error || 'CLI bridge failed')));
    }
  }

  async #execute({ task, conversationId, sessionRef, workspace, signal, emit, progress, setSessionRef }, type) {
    const key = conversationId || `task:${task.task_id}`;
    const state = this.processes.get(key) || this.#spawn(key, workspace);
    if (state.pending) throw new Error(`CLI conversation is busy: ${key}`);
    const stableRef = sessionRef || `bridge-${conversationId || crypto.randomUUID()}`;
    setSessionRef?.(stableRef);
    const result = await new Promise((resolve, reject) => {
      state.pending = { resolve, reject, emit, progress, setSessionRef, sessionRef: stableRef };
      try {
        writeJson(state.child, {
          type, task_id: task.task_id, conversation_id: conversationId,
          session_ref: stableRef, workspace, prompt: defaultPrompt(task), task,
        });
      } catch (error) { state.pending = null; reject(error); }
      signal?.addEventListener('abort', () => {
        if (state.pending) {
          try { writeJson(state.child, { type: 'cancel', task_id: task.task_id, conversation_id: conversationId, session_ref: stableRef }); } catch { /* process may already be gone */ }
          state.pending = null;
          reject(new Error('CLI task cancelled'));
        }
      }, { once: true });
    });
    return result;
  }

  describe() { return { kind: 'workflow-jsonl', version: '1', capabilities: ['run', 'resume', 'inject', 'cancel', 'interaction'] }; }
  async checkHealth() { return { ok: true, command: this.command }; }
  async start() {}
  run(options) { return this.#execute(options, 'run'); }
  resume(options) { return this.#execute(options, 'resume'); }
  execute(options) { return this.run(options); }

  resolveInteraction({ task, conversationId, sessionRef, response }) {
    const state = this.processes.get(conversationId || `task:${task.task_id}`);
    if (!state) return false;
    try { writeJson(state.child, { type: 'interaction_response', task_id: task.task_id, conversation_id: conversationId, session_ref: sessionRef, response }); } catch { return false; }
    return true;
  }

  inject({ task, conversationId, sessionRef, content }) {
    const state = this.processes.get(conversationId || `task:${task.task_id}`);
    if (!state) return false;
    try { writeJson(state.child, { type: 'inject', task_id: task.task_id, conversation_id: conversationId, session_ref: sessionRef, content }); return true; } catch { return false; }
  }

  cancel({ task, conversationId, sessionRef }) {
    const state = this.processes.get(conversationId || `task:${task.task_id}`);
    if (!state) return false;
    try { writeJson(state.child, { type: 'cancel', task_id: task.task_id, conversation_id: conversationId, session_ref: sessionRef }); } catch { return false; }
    return true;
  }

  close() {
    for (const state of this.processes.values()) state.child.kill?.();
    this.processes.clear();
  }

  async dispose() { this.close(); }
}
