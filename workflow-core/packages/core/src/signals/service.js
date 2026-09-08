// signals/service.js - turning an observation into an update to the model.
//
// A signal is evidence, never a trigger. Attaching one to a responsibility
// updates when that responsibility last moved; it does not by itself decide to
// interrupt anyone. Only signals aimed at the user (a mention, a reply, a
// direct message) may open a new responsibility, and those open it quietly.
export const SIGNAL_KINDS = ['mention', 'reply', 'direct', 'ambient'];

const DIRECTED_KINDS = new Set(['mention', 'reply', 'direct']);
const MAX_EXCERPT = 200;
const MAX_STATEMENT = 120;
const UNCLASSIFIED_PREFIX = '待确认：';

export function createSignalService({ signalRepository, commitmentService, log = () => {} } = {}) {
  if (!signalRepository) throw new TypeError('signalRepository is required');
  if (!commitmentService) throw new TypeError('commitmentService is required');

  function attach(signal) {
    if (!DIRECTED_KINDS.has(signal.kind)) return { attached: null, opened: null, reason: 'ambient' };
    const candidates = commitmentService.list({ state: 'active', limit: 1000 }).filter((commitment) => (
      (signal.projectId && commitment.projectId === signal.projectId)
      || (signal.chatRef && commitment.channelRef === signal.chatRef)
    ));
    if (candidates.length === 1) {
      commitmentService.attachSignal(candidates[0].commitmentId, signal.signalId);
      return { attached: candidates[0].commitmentId, opened: null };
    }
    // Ambiguous matches are left alone: guessing which responsibility a message
    // belongs to is worse than not attaching it.
    if (candidates.length > 1) return { attached: null, opened: null, reason: 'ambiguous' };

    // Nothing matched: record a quiet responsibility. daily_digest means it
    // accumulates into the digest but never interrupts on its own, and the
    // prefix marks it as not yet classified.
    const opened = commitmentService.open({
      statement: `${UNCLASSIFIED_PREFIX}${String(signal.excerpt ?? '未描述的责任').slice(0, MAX_STATEMENT)}`,
      project_id: signal.projectId,
      channel_ref: signal.chatRef,
      trigger_policy: 'on_signal',
      attention_policy: 'daily_digest',
      source_signal_ids: [signal.signalId],
      actor: 'signal',
    }).commitment;
    return { attached: null, opened: opened.commitmentId };
  }

  function record({
    channel, sourceRef, kind = 'ambient', chatRef = null,
    projectId = null, senderRef = null, text = '',
  } = {}) {
    if (!channel || !sourceRef) throw new TypeError('channel and sourceRef are required');
    const normalizedKind = SIGNAL_KINDS.includes(kind) ? kind : 'ambient';
    const excerpt = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT) || null;
    const { signal, created } = signalRepository.record({
      channel, sourceRef, kind: normalizedKind, chatRef, projectId, senderRef, excerpt,
    });
    // A redelivered event is already recorded; do not attach it twice.
    if (!created) return { signal, created: false, attached: null, opened: null, reason: 'duplicate' };
    let outcome;
    try {
      outcome = attach(signal);
    } catch (error) {
      // Signal recording must never break the channel that produced it.
      log(`[signals] attach failed for ${signal.signalId}: ${error.message}`);
      outcome = { attached: null, opened: null, reason: 'attach_failed' };
    }
    return { signal, created: true, ...outcome };
  }

  return {
    record,
    get: (signalId) => signalRepository.get(signalId),
    list: (options) => signalRepository.list(options),
  };
}
