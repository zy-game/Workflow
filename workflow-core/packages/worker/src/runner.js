import crypto from 'node:crypto';

const MAX_SLOTS_DEFAULT = 2;
const RESUME_FAILURE_CODES = new Set([
  'resume_state_missing', 'resume_session_missing', 'backend_resume_unsupported', 'awaiting_input_unresumable',
]);
function resumeError(code, message) { const error = new Error(message); error.code = code; return error; }

export class TaskRunner {
  constructor({ core, backendRegistry, runStore, projectRegistry = null, interactionBridge = null, log = () => {}, maxSlots = MAX_SLOTS_DEFAULT } = {}) {
    if (!core || !backendRegistry || !runStore) throw new TypeError('core, backendRegistry and runStore are required');
    this.core = core; this.backendRegistry = backendRegistry; this.runStore = runStore; this.projectRegistry = projectRegistry; this.interactionBridge = interactionBridge; this.log = log; this.maxSlots = maxSlots;
    this.slots = new Map(); this.operations = new Set(); this.stopping = false;
    this.core.onAck?.((frameId) => {
      for (const run of this.runStore.list()) {
        if (run.phase === 'completion_pending' && run.terminalFrameId === frameId) {
          this.runStore.delete(run.taskId);
        }
      }
    });
  }
  async #track(operation) { if (this.stopping) return false; const pending = Promise.resolve().then(operation); this.operations.add(pending); try { return await pending; } finally { this.operations.delete(pending); } }
  handleDispatch(task, options = {}) {
    return this.#track(async () => {
      try {
        return await this.#dispatch(task, options);
      } catch (error) {
        if (options.resumed && RESUME_FAILURE_CODES.has(error?.code)) {
          this.#failClosed(task, error);
          return false;
        }
        throw error;
      }
    });
  }
  async #dispatch(task, { resumed = false } = {}) {
    const existing = this.slots.get(task.task_id); if (existing) return existing.task.claim_token === task.claim_token;
    if (this.slots.size >= this.maxSlots) return false;
    const entry = this.backendRegistry.get(task.backend_kind); if (!entry) throw resumeError('backend_unavailable', `backend is not configured: ${task.backend_kind}`);
    const prior = this.runStore.get(task.task_id);
    const sessionRef = prior?.sessionRef ?? task.session_ref ?? null;
    if (resumed) {
      if (!prior || prior.claimToken !== task.claim_token) throw resumeError('resume_state_missing', 'resumed task has no matching local run');
      if (prior.phase === 'awaiting_input') throw resumeError('awaiting_input_unresumable', 'worker restarted while the task awaited local input; the backend session cannot be restored');
      if (!sessionRef) throw resumeError('resume_session_missing', 'resumed task has no persisted session ref');
      if (typeof entry.backend.resume !== 'function') throw resumeError('backend_resume_unsupported', 'backend does not support resume');
    }
    const slot = { task, backend: entry.backend, sessionRef, controller: new AbortController(), detached: false };
    this.runStore.put({ taskId: task.task_id, claimToken: task.claim_token, projectId: task.project_id, backendKind: task.backend_kind, sessionRef, phase: resumed ? 'running' : 'dispatched', lastEventSeq: prior?.lastEventSeq ?? -1, lastAssistant: prior?.lastAssistant ?? null, interactionId: prior?.interactionId ?? null });
    this.slots.set(task.task_id, slot);
    const emit = (event) => this.#emit(slot, event);
    const progress = (note, percent, events = []) => this.core.send('progress', { task_id: task.task_id, claim_token: task.claim_token, note, percent, events });
    try {
      progress(resumed ? 'resumed' : 'started', 0);
      const project = task.project_id ? this.projectRegistry?.resolve(task.project_id) : null;
      const options = {
        task,
        projectId: task.project_id ?? null,
        conversationId: task.conversation_id ?? task.conversationId ?? null,
        workspace: project?.root ?? null,
        sessionRef: slot.sessionRef,
        signal: slot.controller.signal,
        emit,
        progress,
        setSessionRef: (ref) => { slot.sessionRef = ref; this.runStore.update(task.task_id, { sessionRef: ref }); },
      };
      const result = resumed ? await slot.backend.resume(options) : await slot.backend.run(options);
      if (slot.controller.signal.aborted || slot.detached) return false;
      const sessionRefResult = result?.sessionRef || slot.sessionRef;
      return this.#complete(slot, task, {
        kind: result?.kind || 'done',
        result: result?.result ?? result ?? {},
        sessionRef: sessionRefResult,
      });
    } catch (error) {
      if (!slot.controller.signal.aborted && !slot.detached) {
        this.#complete(slot, task, {
          kind: 'failed',
          result: { error: error.message },
          sessionRef: slot.sessionRef,
        });
      }
      throw error;
    }
  }
  #complete(slot, task, { kind, result, sessionRef }) {
    const terminalType = kind === 'failed' ? 'task_failed' : 'task_done';
    const terminalFrameId = crypto.randomUUID();
    this.runStore.update(task.task_id, { sessionRef, phase: 'completion_pending', result, terminalFrameId });
    const payload = { task_id: task.task_id, claim_token: task.claim_token, session_ref: sessionRef, result };
    if (terminalType === 'task_done') payload.kind = kind;
    const sent = this.core.send(terminalType, payload, { id: terminalFrameId });
    this.slots.delete(task.task_id);
    return sent;
  }
  #failClosed(task, error) {
    const terminalFrameId = crypto.randomUUID();
    const result = { error: error.message };
    this.runStore.put({
      taskId: task.task_id, claimToken: task.claim_token, projectId: task.project_id ?? null,
      backendKind: task.backend_kind, sessionRef: task.session_ref ?? null,
      phase: 'completion_pending', result, terminalFrameId,
    });
    const sent = this.core.send('task_failed', {
      task_id: task.task_id, claim_token: task.claim_token, session_ref: task.session_ref ?? null, result,
    }, { id: terminalFrameId });
    this.log(`[worker] fail closed ${task.task_id}: ${error.message}`);
    return sent;
  }
  #emit(slot, event) {
    if (slot.detached) return false;
    if (event?.type === 'interaction_required' && this.interactionBridge) {
      const interaction = event.interaction ?? event.payload ?? event;
      this.runStore.update(slot.task.task_id, { phase: 'awaiting_input', interactionId: interaction.interaction_id ?? null });
      return this.interactionBridge.required({ task: slot.task, interaction, sessionRef: slot.sessionRef });
    }
    return this.core.send('session_event', { task_id: slot.task.task_id, claim_token: slot.task.claim_token, session_ref: slot.sessionRef, event });
  }
  handleInject(taskId, content) { return this.#track(async () => { const slot = this.slots.get(taskId); if (!slot) return false; return slot.backend.inject?.({ task: slot.task, sessionRef: slot.sessionRef, content }) !== false; }); }
  handleCancel(taskId) {
    return this.#track(async () => {
      const slot = this.slots.get(taskId);
      const run = this.runStore.get(taskId);
      if (!slot && !run) return false;
      if (slot) {
        slot.controller.abort();
        slot.cancelled = true;
        await slot.backend.cancel?.({ task: slot.task, sessionRef: slot.sessionRef });
        this.slots.delete(taskId);
      }
      if (run && !(run.phase === 'completion_pending' && run.terminalFrameId)) this.runStore.delete(taskId);
      return true;
    });
  }
  handleInteractionResponse(payload) {
    return this.#track(async () => {
      const slot = this.slots.get(payload.task_id);
      if (!slot || !this.interactionBridge) return false;
      const ok = await this.interactionBridge.response({ task: slot.task, interaction_id: payload.interaction_id, response: payload.response });
      if (ok) {
        const current = this.runStore.get(payload.task_id);
        if (current && current.phase !== 'completion_pending') {
          this.runStore.update(payload.task_id, { phase: 'running', interactionId: null });
        }
      }
      return ok;
    });
  }
  handleInteractionCancel(payload) { return this.#track(async () => { const slot = this.slots.get(payload.task_id); if (!slot || !this.interactionBridge) return false; return this.interactionBridge.cancel({ task: slot.task, interaction_id: payload.interaction_id }); }); }
  async detachAll() { this.stopping = true; await Promise.allSettled([...this.operations]); for (const slot of this.slots.values()) slot.detached = true; this.slots.clear(); }
  async stopAll() { return this.detachAll(); }
}

export function buildPrompt(task) { const brief = task.brief ?? {}; if (brief.prompt) return String(brief.prompt); const lines = [`目标：${brief.goal ?? task.type}`]; if (Array.isArray(brief.acceptance) && brief.acceptance.length) lines.push(`验收标准：\n${brief.acceptance.map((item) => `- ${item}`).join('\n')}`); if (brief.context) lines.push(`上下文：\n${brief.context}`); return `${lines.join('\n\n')}\n\n完成全部工作后输出最终结论。`; }
export function assistantText(event) { return typeof event?.text === 'string' ? event.text : null; }
