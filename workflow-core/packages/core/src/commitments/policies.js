// commitments/policies.js - when a commitment is re-evaluated, and when that
// evaluation may become something that interrupts the user.
//
// Two separate clocks, deliberately:
//   trigger_policy   - when to re-check the commitment
//   attention_policy - when a re-check is allowed to become a proposal
//
// Keeping them apart is what lets "keep main green" be checked daily but only
// interrupt the user once the build has been red for three days. Collapsing
// them into one policy is what turns an assistant into a notification firehose.
export const TRIGGER_KINDS = ['on_signal', 'on_state_change', 'every', 'at'];
export const ATTENTION_KINDS = ['immediate', 'daily_digest', 'threshold'];

const DURATION_PATTERN = /^(\d+)([mhd])$/;
const THRESHOLD_PATTERN = /^(stale|due)([<>])(\d+)([mhd])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(value) {
  const match = DURATION_PATTERN.exec(String(value ?? '').trim());
  if (!match) return null;
  return Number(match[1]) * UNIT_MS[match[2]];
}

// 'on_signal' | 'on_state_change' | 'every:1d' | 'at:<ISO timestamp>'
export function parseTriggerPolicy(value) {
  const text = String(value ?? '').trim();
  if (text === 'on_signal' || text === 'on_state_change') return { kind: text, raw: text };
  if (text.startsWith('every:')) {
    const everyMs = parseDuration(text.slice('every:'.length));
    return everyMs == null ? null : { kind: 'every', everyMs, raw: text };
  }
  if (text.startsWith('at:')) {
    const atMs = Date.parse(text.slice('at:'.length));
    return Number.isNaN(atMs) ? null : { kind: 'at', atMs, raw: text };
  }
  return null;
}

// 'immediate' | 'daily_digest' | 'threshold:stale>5d' | 'threshold:due<2d'
export function parseAttentionPolicy(value) {
  const text = String(value ?? '').trim();
  if (text === 'immediate' || text === 'daily_digest') return { kind: text, raw: text };
  if (text.startsWith('threshold:')) {
    const match = THRESHOLD_PATTERN.exec(text.slice('threshold:'.length).trim());
    if (!match) return null;
    return {
      kind: 'threshold',
      metric: match[1],
      comparator: match[2],
      thresholdMs: Number(match[3]) * UNIT_MS[match[4]],
      raw: text,
    };
  }
  return null;
}

function parseTime(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function evaluateTrigger(trigger, { commitment, now, signalAttached = false } = {}) {
  switch (trigger.kind) {
    case 'on_signal':
    case 'on_state_change':
      return signalAttached;
    case 'every': {
      const last = parseTime(commitment.lastEvaluatedAt) ?? parseTime(commitment.createdAt);
      return last == null || now - last >= trigger.everyMs;
    }
    case 'at':
      return now >= trigger.atMs;
    default:
      return false;
  }
}

// Returns whether the condition holds. Suppressing repeats is the caller's job,
// because the right cooldown depends on the channel, not on the policy text.
export function evaluateAttention(attention, { commitment, now } = {}) {
  switch (attention.kind) {
    case 'immediate':
      return { fire: true, reason: 'immediate' };
    case 'daily_digest':
      return { fire: false, reason: 'digest' };
    case 'threshold': {
      const reference = attention.metric === 'due'
        ? parseTime(commitment.dueAt)
        : parseTime(commitment.lastActivityAt) ?? parseTime(commitment.updatedAt);
      if (reference == null) return { fire: false, reason: 'no_reference' };
      const elapsed = attention.metric === 'due' ? reference - now : now - reference;
      const fire = attention.comparator === '>' ? elapsed > attention.thresholdMs : elapsed < attention.thresholdMs;
      return { fire, reason: fire ? attention.raw : null };
    }
    default:
      return { fire: false, reason: null };
  }
}
