import { validateInteractionRequest, validateInteractionResponse } from '@workflow-core/shared';

export class InteractionBridge {
  constructor({ core, backendRegistry, log = () => {} } = {}) { this.core = core; this.backendRegistry = backendRegistry; this.log = log; this.pending = new Map(); }
  required({ task, interaction, sessionRef }) {
    validateInteractionRequest({ ...interaction, task_id: task.task_id });
    this.pending.set(interaction.interaction_id, { task, interaction, sessionRef });
    return this.core.send('interaction_required', { task_id: task.task_id, claim_token: task.claim_token, session_ref: sessionRef, ...interaction });
  }
  async response({ task, interaction_id, response }) {
    validateInteractionResponse({ interaction_id, ...response });
    const pending = this.pending.get(interaction_id);
    if (!pending || pending.task.task_id !== task.task_id) return false;
    const backend = this.backendRegistry.get(task.backend_kind)?.backend;
    const accepted = await backend?.resolveInteraction?.({ task, sessionRef: pending.sessionRef, response });
    if (accepted === false) return false;
    this.pending.delete(interaction_id);
    this.core.send('interaction_resolved', { task_id: task.task_id, claim_token: task.claim_token, interaction_id, session_ref: pending.sessionRef });
    return true;
  }
  cancel({ task, interaction_id }) {
    const pending = this.pending.get(interaction_id);
    if (!pending || pending.task.task_id !== task.task_id) return false;
    this.pending.delete(interaction_id);
    return this.core.send('interaction_resolved', { task_id: task.task_id, claim_token: task.claim_token, interaction_id, cancelled: true });
  }
}
