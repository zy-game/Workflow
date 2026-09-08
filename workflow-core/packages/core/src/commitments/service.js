// commitments/service.js - the judgment loop's data surface.
//
// dueForAttention() is deliberately side-effect free: it reports which
// commitments are due and whose attention policy fires. Deciding what to do
// about that (proposal, digest, nothing) belongs to the caller, so the policy
// stays testable and the loop stays predictable.
import {
  evaluateAttention, evaluateTrigger, parseAttentionPolicy, parseTriggerPolicy,
} from './policies.js';

export const COMMITMENT_MAX_STATEMENT_LENGTH = 500;

const ACTION_EVENTS = Object.freeze({
  fulfill: 'fulfilled',
  drop: 'dropped',
  expire: 'expired',
  reactivate: 'reactivated',
  needs_decision: 'needs_decision',
});

export class CommitmentServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createCommitmentService({ commitmentRepository, now = () => new Date() } = {}) {
  if (!commitmentRepository) throw new TypeError('commitmentRepository is required');

  function open({
    commitment_id: commitmentId = null,
    owner_id: ownerId = null,
    project_id: projectId = null,
    channel_ref: channelRef = null,
    statement,
    trigger_policy: triggerPolicy = 'on_signal',
    attention_policy: attentionPolicy = 'immediate',
    due_at: dueAt = null,
    source_signal_ids: sourceSignalIds = [],
    evidence_refs: evidenceRefs = [],
    actor = null,
  } = {}) {
    const text = String(statement ?? '').trim();
    if (!text) throw new CommitmentServiceError('statement_required', 'statement is required');
    if (text.length > COMMITMENT_MAX_STATEMENT_LENGTH) {
      throw new CommitmentServiceError('statement_too_long', `statement exceeds ${COMMITMENT_MAX_STATEMENT_LENGTH} characters`);
    }
    if (!parseTriggerPolicy(triggerPolicy)) {
      throw new CommitmentServiceError('trigger_policy_invalid', `unsupported trigger policy: ${triggerPolicy}`);
    }
    if (!parseAttentionPolicy(attentionPolicy)) {
      throw new CommitmentServiceError('attention_policy_invalid', `unsupported attention policy: ${attentionPolicy}`);
    }
    if (dueAt != null && Number.isNaN(Date.parse(dueAt))) {
      throw new CommitmentServiceError('due_at_invalid', 'due_at must be an ISO timestamp');
    }
    if (commitmentId) {
      const existing = commitmentRepository.get(String(commitmentId));
      if (existing) return { commitment: existing, created: false };
    }
    const commitment = commitmentRepository.create({
      commitmentId: commitmentId ? String(commitmentId) : undefined,
      ownerId, projectId, channelRef, statement: text,
      triggerPolicy, attentionPolicy, dueAt,
      sourceSignalIds, evidenceRefs, actor,
    });
    return { commitment, created: true };
  }

  function transition({ commitmentId, action, actor = null, payload = {} }) {
    const type = ACTION_EVENTS[action];
    if (!type) {
      throw new CommitmentServiceError('action_invalid', `action must be one of ${Object.keys(ACTION_EVENTS).join(', ')}`);
    }
    const commitment = commitmentRepository.applyEvent({ commitmentId, type, actor, payload });
    if (!commitment) throw new CommitmentServiceError('commitment_not_found', 'commitment does not exist');
    return commitment;
  }

  // Which commitments deserve attention right now. `signalIds` are the signals
  // being processed; they satisfy on_signal triggers.
  function dueForAttention({ at = null, signalIds = [] } = {}) {
    const nowMs = at == null ? now().getTime() : Date.parse(at);
    const due = [];
    for (const commitment of commitmentRepository.list({ state: 'active', limit: 1000 })) {
      const trigger = parseTriggerPolicy(commitment.triggerPolicy);
      const attention = parseAttentionPolicy(commitment.attentionPolicy);
      if (!trigger || !attention) continue;
      if (!evaluateTrigger(trigger, { commitment, now: nowMs, signalAttached: signalIds.length > 0 })) continue;
      // A periodic check must not nag: at most one interruption per cycle.
      if (trigger.kind === 'every' && commitment.lastAttentionAt) {
        const lastAttention = Date.parse(commitment.lastAttentionAt);
        if (!Number.isNaN(lastAttention) && nowMs - lastAttention < trigger.everyMs) continue;
      }
      const verdict = evaluateAttention(attention, { commitment, now: nowMs });
      if (!verdict.fire) continue;
      due.push({ commitment, reason: verdict.reason, trigger: trigger.kind, attention: attention.kind });
    }
    return due;
  }

  function markEvaluated(commitmentId, at = now().toISOString()) {
    return commitmentRepository.touch(commitmentId, { lastEvaluatedAt: at });
  }

  // Quiet responsibilities: allowed to accumulate, never to interrupt on their
  // own. They are delivered in a digest, and an item already delivered is not
  // repeated - the digest is a notice, not a recurring nag.
  function pendingDigest({ limit = 50 } = {}) {
    const bounded = Math.min(200, Math.max(1, Number(limit) || 50));
    return commitmentRepository.list({ state: 'active', limit: 1000 })
      .filter((commitment) => (
        parseAttentionPolicy(commitment.attentionPolicy)?.kind === 'daily_digest'
        && !commitment.lastAttentionAt
      ))
      .slice(0, bounded);
  }

  function markAttention(commitmentId, at = now().toISOString()) {
    return commitmentRepository.touch(commitmentId, { lastAttentionAt: at });
  }

  function markActivity(commitmentId, at = now().toISOString()) {
    return commitmentRepository.touch(commitmentId, { lastActivityAt: at });
  }

  // A signal touched this responsibility: remember where it came from and when
  // it last moved. The activity timestamp is what staleness thresholds read.
  function attachSignal(commitmentId, signalId, at = now().toISOString()) {
    const commitment = commitmentRepository.addSourceSignal(commitmentId, signalId);
    if (!commitment) throw new CommitmentServiceError('commitment_not_found', 'commitment does not exist');
    commitmentRepository.applyEvent({
      commitmentId, type: 'signal_attached', payload: { signal_id: signalId }, actor: 'signal',
    });
    return commitmentRepository.touch(commitmentId, { lastActivityAt: at });
  }

  return {
    open,
    transition,
    dueForAttention,
    pendingDigest,
    markEvaluated,
    markAttention,
    markActivity,
    attachSignal,
    get: (commitmentId) => commitmentRepository.get(commitmentId),
    list: (options) => commitmentRepository.list(options),
    events: (commitmentId) => commitmentRepository.events(commitmentId),
  };
}
