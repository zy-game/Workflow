// omp-rpc.js - OMP (oh-my-pi) backend speaking the official --mode rpc
// protocol: commands are JSON lines on stdin (prompt/steer/abort/follow_up/
// get_state/get_last_assistant_text/extension_ui_response), frames are JSON
// lines on stdout (ready/response/prompt_result/extension_ui_request/...).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_LINE_BYTES = 1024 * 1024;
const READY_TIMEOUT_MS = 15_000;

const CONTROL_TYPES = new Set([
  'ready', 'response', 'prompt_result', 'available_commands_update',
  'extension_ui_request', 'advisor_cost_changed', 'rpc_chunk',
  'subagent_lifecycle', 'subagent_progress', 'subagent_event',
  'host_tool_call', 'host_tool_cancel', 'host_tool_update', 'host_tool_result',
  'host_uri_request', 'host_uri_cancel', 'host_uri_result',
]);

const UI_KINDS = { confirm: 'approval', input: 'question', select: 'question', editor: 'question' };

function resultError(message, code = 'OMP_RPC_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defaultPrompt(task) {
  const brief = task.brief || {};
  return String(brief.prompt || brief.goal || task.type || '');
}

export class OmpRpcBackend {
  constructor({
    command = 'bun', args = [], cwd = null, env = {}, spawnImpl = spawn,
    log = () => {}, agentDir = null, userProfile = null, model = null, provider = null,
  } = {}) {
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = { ...env };
    this.spawnImpl = spawnImpl;
    this.log = log;
    this.agentDir = agentDir;
    this.userProfile = userProfile;
    this.model = model;
    this.provider = provider;
    this.sessions = new Map();
  }

  describe() {
    return { kind: 'omp-rpc', version: '1', capabilities: ['run', 'inject', 'cancel', 'interaction'] };
  }

  async checkHealth() { return { ok: true, command: this.command }; }

  #key(options) { return options.projectId || options.task?.project_id || options.task?.task_id; }

  #childEnv() {
    const env = { ...process.env, ...this.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('WFC_') || /(TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete env[key];
    }
    if (this.userProfile) {
      env.USERPROFILE = this.userProfile;
      env.HOME = this.userProfile;
    }
    if (this.agentDir) env.OMP_AGENT_DIR = this.agentDir;
    return env;
  }

  #start(key, workspace) {
    const state = {
      buffer: '',
      ready: null,
      prompt: null,
      rpc: new Map(),
      ui: [],
      closed: false,
      retried: false,
    };
    state.ready = new Promise((resolve, reject) => {
      state.readyResolve = resolve;
      state.readyReject = reject;
    });
    this.#attach(state, key, workspace);
    this.sessions.set(key, state);
    return state;
  }

  #cleanDaemons() {
    try {
      const args = this.args;
      const index = args.indexOf('--profile');
      const profile = index >= 0 && args[index + 1] ? String(args[index + 1]) : null;
      const home = this.userProfile || os.homedir();
      const profileDir = profile ? path.join(home, '.omp', 'profiles', profile, 'run') : path.join(home, '.omp', 'run');
      fs.rmSync(path.join(profileDir, 'daemons'), { recursive: true, force: true });
    } catch { /* best effort; OMP will surface any real failure */ }
  }

  #attach(state, key, workspace) {
    // OMP computes a stable daemon id from (profile, home, cwd) and dies with
    // mkdir EEXIST when a previous run left its daemon dir behind. When that
    // happens, clear the stale dirs and respawn once; then fail as usual.
    this.#cleanDaemons();
    const child = this.spawnImpl(this.command, [...this.args], {
      cwd: this.cwd || workspace || process.cwd(),
      env: this.#childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    state.child = child;
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => this.#consume(state, String(chunk)));
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      state.stderrTail = String(chunk).slice(-4000);
      try { fs.appendFileSync(path.join(process.env.WFC_WORKER_STATE_DIR || os.tmpdir(), 'omp-stderr.raw.log'), String(chunk)); } catch { /* best effort */ }
      this.log(`[omp] ${String(chunk).trim()}`);
    });
    const fail = (error) => {
      if (state.closed) return;
      if (!state.retried && !state.readyDone) {
        state.retried = true;
        this.log(`[omp] startup failure (${error.message.slice(0, 120)}); respawning once after clearing stale daemon dirs`);
        this.#attach(state, key, workspace);
        return;
      }
      state.closed = true;
      state.readyReject?.(error);
      if (state.prompt) { const p = state.prompt; state.prompt = null; p.reject(error); }
      for (const entry of state.rpc.values()) entry.reject(error);
      state.rpc.clear();
      state.ui = [];
      if (this.sessions.get(key) === state) this.sessions.delete(key);
    };
    child.once?.('error', (error) => fail(error));
    child.once?.('exit', (code, signal) => fail(resultError(
      `OMP RPC exited (${code ?? signal ?? 'unknown'}): ${(state.stderrTail ?? '').slice(-200)}`,
      'OMP_RPC_EXIT',
    )));
    return state;
  }

  #write(state, message) {
    if (!state.child.stdin || state.child.stdin.destroyed) throw resultError('OMP RPC stdin is closed', 'OMP_RPC_CLOSED');
    state.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consume(state, chunk) {
    state.buffer += chunk;
    if (Buffer.byteLength(state.buffer, 'utf8') > MAX_LINE_BYTES) {
      state.child.kill?.('SIGTERM');
      return;
    }
    let index;
    while ((index = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, index).trim();
      state.buffer = state.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (error) { this.log(`[omp] invalid RPC line: ${error.message}`); continue; }
      this.#frame(state, message);
    }
  }

  #frame(state, message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'ready') { state.readyDone = true; state.readyResolve?.(); state.readyResolve = null; return; }
    if (message.type === 'response') {
      const entry = state.rpc.get(String(message.id));
      if (entry) {
        state.rpc.delete(String(message.id));
        if (message.success === false) entry.reject(resultError(message.error || 'OMP RPC request failed', message.code || 'OMP_RPC_ERROR'));
        else entry.resolve(message.data ?? {});
        return;
      }
      if (state.prompt && (state.prompt.id === message.id || state.prompt.command === message.command)) {
        if (message.success === false) {
          const p = state.prompt; state.prompt = null; p.reject(resultError(message.error || 'OMP RPC request failed', message.code || 'OMP_RPC_ERROR'));
        } else {
          state.prompt.accepted = true;
        }
      }
      return;
    }
    if (message.type === 'prompt_result' || message.type === 'agent_end') {
      if (state.prompt) { const p = state.prompt; state.prompt = null; p.resolve(message ?? {}); }
      return;
    }
    if (message.type === 'extension_ui_request') {
      const kind = UI_KINDS[message.method] ?? null;
      if (!kind || !state.prompt) return;
      const interactionId = crypto.randomUUID();
      const requestId = String(message.id || crypto.randomUUID());
      state.ui.push({ requestId, interactionId });
      state.prompt.emit?.({
        type: 'interaction_required',
        interaction: {
          interaction_id: interactionId,
          task_id: state.prompt.task.task_id,
          kind,
          schema: {
            title: String(message.title ?? ''),
            message: String(message.message ?? ''),
            placeholder: message.placeholder ?? null,
            options: Array.isArray(message.options) ? message.options.map((o) => ({ label: String(o) })) : null,
          },
        },
      });
      return;
    }
    if (CONTROL_TYPES.has(message.type)) {
      if (!['advisor_cost_changed', 'available_commands_update', 'extension_ui_request'].includes(message.type)) {
        if (state.prompt) state.prompt.emit?.({ ...message });
      }
      return;
    }
    if (state.prompt) state.prompt.emit?.(message);
  }

  async #ensureReady(state) {
    if (state.readyResolve) {
      const timer = setTimeout(() => state.readyReject(resultError('OMP RPC did not become ready', 'OMP_RPC_TIMEOUT')), READY_TIMEOUT_MS);
      timer.unref?.();
      try {
        await state.ready;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async #request(state, type, params = {}) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      state.rpc.set(id, { resolve, reject });
      try {
        this.#write(state, { id, type, ...params });
      } catch (error) {
        state.rpc.delete(id);
        reject(error);
      }
    });
  }

  async run(options) {
    const key = this.#key(options);
    const state = this.sessions.get(key) || this.#start(key, options.workspace);
    await this.#ensureReady(state);
    if (this.model && this.provider) {
      await this.#request(state, 'set_model', { provider: this.provider, modelId: this.model });
    }
    const id = crypto.randomUUID();
    const task = options.task;
    const invoke = new Promise((resolve, reject) => {
      state.prompt = { id, command: 'prompt', task, emit: options.emit, resolve, reject, accepted: false };
      try {
        this.#write(state, { id, type: 'prompt', message: defaultPrompt(task) });
      } catch (error) {
        state.prompt = null;
        reject(error);
      }
    });
    const aborted = new Promise((_, reject) => {
      if (!options.signal) return;
      options.signal.addEventListener('abort', () => {
        if (state.prompt) {
          const p = state.prompt;
          state.prompt = null;
          try { this.#write(state, { type: 'abort' }); } catch { /* process may be gone */ }
          p.reject(resultError('OMP task cancelled', 'OMP_RPC_CANCELLED'));
        }
        reject(resultError('OMP task cancelled', 'OMP_RPC_CANCELLED'));
      }, { once: true });
    });
    const promptResult = await Promise.race([invoke, aborted]);
    const session = await this.#request(state, 'get_state');
    const last = await this.#request(state, 'get_last_assistant_text');
    const sessionRef = session?.sessionId ?? session?.sessionFile ?? options.sessionRef ?? null;
    if (sessionRef) options.setSessionRef?.(sessionRef);
    return {
      kind: 'done',
      sessionRef,
      result: {
        text: last?.text ?? null,
        sessionId: session?.sessionId ?? null,
        agentInvoked: promptResult?.agentInvoked ?? true,
      },
    };
  }

  inject({ task, projectId, sessionRef, content }) {
    const state = this.sessions.get(projectId || task.task_id);
    if (!state) return false;
    try { this.#write(state, { type: 'steer', message: String(content ?? '继续') }); return true; } catch { return false; }
  }

  cancel({ task, projectId, sessionRef }) {
    const state = this.sessions.get(projectId || task.task_id);
    if (!state) return false;
    try { this.#write(state, { type: 'abort' }); return true; } catch { return false; }
  }

  resolveInteraction({ task, projectId, sessionRef, response }) {
    const state = this.sessions.get(projectId || task.task_id);
    if (!state) return false;
    const entry = state.ui.shift();
    if (!entry) return false;
    const answers = (response?.answers ?? response ?? {});
    try {
      if (Object.hasOwn(answers, 'confirmed')) {
        this.#write(state, { type: 'extension_ui_response', id: entry.requestId, confirmed: Boolean(answers.confirmed) });
      } else {
        this.#write(state, { type: 'extension_ui_response', id: entry.requestId, value: String(answers.value ?? answers.choice ?? '') });
      }
      return true;
    } catch { return false; }
  }

  async dispose() {
    for (const state of this.sessions.values()) state.child.kill?.('SIGTERM');
    this.sessions.clear();
  }
}
