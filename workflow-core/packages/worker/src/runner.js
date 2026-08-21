// runner.js - executes dispatched tasks inside the local DSH and streams the
// session back to the core. Completion marker: a `turn/end` event (the fake
// DSH in tests implements it; the real-DSH marker is verified at deployment).
import { PROMPT_POLL_MS } from './dsh-local.js';

const MAX_SLOTS_DEFAULT = 2;

const CONTINUATION_PROMPT = [
  '任务因服务重启被中断。请基于会话中已有的进展继续完成任务；',
  '若已基本完成，请直接输出最终结论。不要重复已完成的段落。',
].join('');

function resumeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Real DSH delivers assistant output as streaming assistant/chunk events plus
// a final assistant/message whose content is an array of typed parts; the
// test fake uses a flat data.text. Both shapes must resolve to plain text or
// summaries, cards, and knowledge extraction stay empty.
export function assistantText(event) {
  const data = event?.data;
  if (typeof data?.text === 'string') return data.text;
  const parts = data?.message?.content;
  if (Array.isArray(parts)) {
    const text = parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    return text || null;
  }
  return null;
}

export class TaskRunner {
  constructor({
    core, dsh, stateStore = null, workspaceResolver = () => null, log = () => {}, pollMs = PROMPT_POLL_MS,
    defaultWorkspace = '.', maxSlots = MAX_SLOTS_DEFAULT,
  }) {
    this.core = core;
    this.dsh = dsh;
    this.stateStore = stateStore;
    this.workspaceResolver = workspaceResolver;
    this.log = log;
    this.pollMs = pollMs;
    this.defaultWorkspace = defaultWorkspace;
    this.maxSlots = maxSlots;
    this.slots = new Map(); // task_id -> { task, sessionId, lastSeq, timer, lastAssistant }
    this.operations = new Set();
    this.stopping = false;
  }

  // Slot factory fields shared by fresh dispatch and resume: approvals maps
  // DSH approvalId -> { rpcId, payload } for turns blocked on permission.

  // Queued injections open another turn after the current one ends; the task
  // may only complete after the last injected turn finishes.

  async #track(operation) {
    if (this.stopping) return false;
    const pending = Promise.resolve().then(operation);
    this.operations.add(pending);
    try {
      return await pending;
    } finally {
      this.operations.delete(pending);
    }
  }

  get busyCount() {
    return this.slots.size;
  }

  handleDispatch(task, options = {}) {
    return this.#track(() => this.#handleDispatch(task, options));
  }

  async #handleDispatch(task, { resumed = false } = {}) {
    const existingSlot = this.slots.get(task.task_id);
    if (existingSlot) return existingSlot.task.claim_token === task.claim_token;
    if (this.slots.size >= this.maxSlots) return false;

    const persisted = this.stateStore?.get(task.task_id) ?? null;
    if (resumed) {
      if (!persisted || persisted.claimToken !== task.claim_token) {
        throw resumeError('resume_state_missing', 'resumed task has no matching local session state');
      }
      if (!['running', 'completion_pending'].includes(persisted.phase)) {
        throw resumeError('resume_state_ambiguous', `cannot safely resume task from phase ${persisted.phase}`);
      }
      const slot = {
        task,
        sessionId: persisted.sessionId,
        lastSeq: persisted.lastSeq,
        timer: null,
        lastAssistant: persisted.lastAssistant,
        phase: persisted.phase,
        pendingInjections: 0,
        continuations: 0,
        approvals: new Map(),
        ticking: false,
        tickPromise: null,
        detached: false,
      };
      let sessionReady = true;
      try {
        await this.dsh.pollEvents(slot.sessionId, slot.lastSeq);
      } catch (error) {
        if (error.code === 'not_found') {
          this.stateStore?.delete(task.task_id);
          throw resumeError('dsh_session_missing', 'persisted DSH session does not exist');
        }
        sessionReady = false;
        this.log(`[runner] session validation deferred for ${task.task_id}: ${error.message}`);
      }
      this.slots.set(task.task_id, slot);
      if (slot.phase === 'completion_pending') {
        await this.#finish(slot, 'done', { summary: slot.lastAssistant ?? '' });
      } else if (sessionReady) {
        await this.#tick(slot);
      }
      if (this.slots.has(task.task_id)) this.#startPolling(slot);
      this.log(`[runner] task ${task.task_id} resumed -> session ${slot.sessionId}`);
      return true;
    }

    if (persisted) {
      await this.dsh.cancel(persisted.sessionId).catch(() => {});
      this.stateStore?.delete(task.task_id);
    }
    const workspace = this.workspaceResolver(task) ?? task.brief?.workspace ?? this.defaultWorkspace;
    const session = await this.dsh.createSession({ workspace, title: task.title ?? task.type });
    const slot = {
      task,
      sessionId: session.sessionId ?? session.id ?? session,
      lastSeq: -1,
      timer: null,
      lastAssistant: null,
      phase: 'created',
      pendingInjections: 0,
      continuations: 0,
      approvals: new Map(),
      ticking: false,
      tickPromise: null,
      detached: false,
    };
    this.stateStore?.put({
      taskId: task.task_id,
      claimToken: task.claim_token,
      sessionId: slot.sessionId,
      phase: 'created',
    });
    this.slots.set(task.task_id, slot);
    this.stateStore?.update(task.task_id, { phase: 'prompting' });
    slot.phase = 'prompting';
    try {
      await this.dsh.prompt(slot.sessionId, buildPrompt(task));
    } catch (error) {
      this.slots.delete(task.task_id);
      throw error;
    }
    this.stateStore?.update(task.task_id, { phase: 'running' });
    slot.phase = 'running';
    this.core.send('progress', { task_id: task.task_id, claim_token: task.claim_token, note: 'session started' });
    this.#startPolling(slot);
    this.log(`[runner] task ${task.task_id} -> session ${slot.sessionId}`);
    return true;
  }

  #startPolling(slot) {
    slot.timer = setInterval(() => {
      if (slot.ticking || slot.detached) return;
      slot.ticking = true;
      slot.tickPromise = this.#tick(slot)
        .catch((error) => this.log(`[runner] tick failed for ${slot.task.task_id}: ${error.message}`))
        .finally(() => {
          slot.ticking = false;
          slot.tickPromise = null;
        });
    }, this.pollMs);
    slot.timer.unref();
  }

  async #tick(slot) {
    if (slot.phase === 'completion_pending') {
      await this.#finish(slot, 'done', { summary: slot.lastAssistant ?? '' });
      return;
    }
    const { events, hasMore } = await this.dsh.pollEvents(slot.sessionId, slot.lastSeq);
    const sentEvents = [];
    for (const event of events) {
      if (slot.detached) return;
      if (event.kind === 'assistant') {
        const text = assistantText(event.event);
        if (text !== null) slot.lastAssistant = text;
      }
      const sent = this.core.send('session_event', { task_id: slot.task.task_id, event });
      if (!sent) return;
      sentEvents.push(event);
      slot.lastSeq = event.seq;
      this.stateStore?.update(slot.task.task_id, {
        lastSeq: slot.lastSeq,
        lastAssistant: slot.lastAssistant,
      });
      if (String(event.event?.type) === 'turn/end') {
        const reason = event.event?.data?.reason?.kind;
        // A worker restart kills the local DSH process mid-turn; the session
        // persists but the turn ends "interrupted". Re-prompt the same session
        // once (context is preserved, the original prompt is never replayed).
        // A second interruption falls through and completes with what exists.
        if (reason === 'interrupted'
            && slot.continuations < 1
            && this.slots.get(slot.task.task_id) === slot) {
          slot.continuations += 1;
          this.stateStore?.update(slot.task.task_id, { phase: 'running' });
          await this.dsh.prompt(slot.sessionId, CONTINUATION_PROMPT);
          this.log(`[runner] task ${slot.task.task_id} interrupted; continuation prompted`);
          return;
        }
        if (slot.pendingInjections > 0) {
          // A queued injection opens another turn; wait for it before done.
          slot.pendingInjections -= 1;
          this.stateStore?.update(slot.task.task_id, { phase: 'running' });
          return;
        }
        slot.phase = 'completion_pending';
        this.stateStore?.update(slot.task.task_id, { phase: 'completion_pending' });
        await this.#finish(slot, 'done', { summary: slot.lastAssistant ?? '' });
        return;
      }
    }
    if (sentEvents.length || hasMore) {
      this.core.send('progress', {
        task_id: slot.task.task_id,
        claim_token: slot.task.claim_token,
        events: sentEvents.map((event) => event.event),
      });
    }
  }

  async #finish(slot, kind, result) {
    if (!this.slots.has(slot.task.task_id)) return false;
    slot.phase = 'completion_pending';
    this.stateStore?.update(slot.task.task_id, { phase: 'completion_pending' });
    let exportMeta = null;
    try {
      const exported = await this.dsh.exportSession(slot.sessionId);
      exportMeta = { format: exported.format, events: exported.events.length };
    } catch (error) {
      this.log(`[runner] export failed for ${slot.task.task_id}: ${error.message}`);
    }
    const sent = this.core.send('task_done', {
      task_id: slot.task.task_id, claim_token: slot.task.claim_token, kind,
      result: { ...result, session_id: slot.sessionId, export: exportMeta },
    });
    if (!sent) return false;
    this.slots.delete(slot.task.task_id);
    clearInterval(slot.timer);
    this.stateStore?.delete(slot.task.task_id);
    this.log(`[runner] task ${slot.task.task_id} finished (${kind})`);
    return true;
  }

  handleInject(taskId, content) {
    return this.#track(() => this.#handleInject(taskId, content));
  }

  async #handleInject(taskId, content) {
    const slot = this.slots.get(taskId);
    if (!slot) return false;
    await this.dsh.prompt(slot.sessionId, content);
    slot.pendingInjections += 1;
    return true;
  }

  handleCancel(taskId) {
    return this.#track(() => this.#handleCancel(taskId));
  }

  // Called by the local DSH mux connection when a turn blocks on permission.
  handleApprovalWaiting(payload, rpcId) {
    const slot = this.#slotForSession(payload.sessionId);
    if (!slot) return;
    slot.approvals.set(payload.approvalId, { rpcId, payload });
    const sent = this.core.send('approval_request', {
      task_id: slot.task.task_id,
      tool: payload.toolName ?? null,
      reason: payload.reason ?? null,
      dsh_approval_id: payload.approvalId,
      dsh_rpc_id: rpcId,
      dsh_session_id: payload.sessionId,
    });
    if (!sent) slot.approvals.delete(payload.approvalId);
    else this.log(`[runner] approval ${payload.approvalId} pending for task ${slot.task.task_id} (${payload.toolName ?? 'tool'})`);
  }

  // Core relayed a decision (Feishu card/reply or admin console).
  handleApprovalResult({ task_id: taskId, dsh_approval_id: approvalId, dsh_rpc_id: rpcId, dsh_session_id: sessionId, approved }) {
    return this.#track(async () => {
      if (!approvalId || !rpcId || !sessionId) {
        this.log(`[runner] approval result for task ${taskId} lacks DSH identifiers; cannot answer local DSH`);
        return false;
      }
      const outcome = approved ? 'allowed-once' : 'rejected';
      await this.dsh.respondApproval({ rpcId, sessionId, approvalId, outcome });
      const slot = this.slots.get(taskId);
      slot?.approvals.delete(approvalId);
      this.log(`[runner] approval ${approvalId} for task ${taskId} answered: ${outcome}`);
      return true;
    });
  }

  #slotForSession(sessionId) {
    for (const slot of this.slots.values()) {
      if (slot.sessionId === sessionId) return slot;
    }
    return null;
  }

  async #handleCancel(taskId) {
    const slot = this.slots.get(taskId);
    const persisted = this.stateStore?.get(taskId) ?? null;
    if (!slot && !persisted) return false;
    if (slot) clearInterval(slot.timer);
    this.slots.delete(taskId);
    await this.dsh.cancel(slot?.sessionId ?? persisted.sessionId).catch(() => {});
    this.stateStore?.delete(taskId);
    this.log(`[runner] task ${taskId} cancelled`);
    return true;
  }

  async detachAll() {
    this.stopping = true;
    await Promise.allSettled([...this.operations]);
    const pending = [];
    for (const slot of this.slots.values()) {
      slot.detached = true;
      clearInterval(slot.timer);
      if (slot.tickPromise) pending.push(slot.tickPromise);
    }
    this.slots.clear();
    await Promise.allSettled(pending);
  }

  async stopAll() {
    await this.detachAll();
  }
}

export function buildPrompt(task) {
  const brief = task.brief ?? {};
  const lines = [];
  if (brief.prompt) {
    lines.push(String(brief.prompt));
  } else {
    lines.push(`目标：${brief.goal ?? task.type}`);
    if (Array.isArray(brief.acceptance) && brief.acceptance.length) {
      lines.push(`验收标准：\n${brief.acceptance.map((item) => `- ${item}`).join('\n')}`);
    }
    if (brief.context) lines.push(`上下文：\n${brief.context}`);
  }
  lines.push('完成全部工作后输出最终结论。');
  return lines.join('\n\n');
}
