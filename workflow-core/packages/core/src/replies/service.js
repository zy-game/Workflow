// replies/service.js - turn an approved proposal into an outbound message.
//
// Two rules are enforced here and nowhere else:
//   1. Nothing is sent without a tier that permits autonomy. T3 (estimates,
//      promises, opinions about people) is never sent automatically.
//   2. Nothing is sent before audience filtering, because the same fact can be
//      safe in a private chat and not in a work group.
//
// The audit row is written before the network call, so a reply that failed to
// send is still on the record.
export const REPLY_TIERS = ['T1', 'T2', 'T3'];
export const AUTO_TIERS = ['T1', 'T2'];
// A group is a wider audience than a private chat: the same sentence can be
// fine in one and unacceptable in the other.
export const AUDIENCES = ['private', 'group'];
const DEFAULT_MAX_CHARS = 600;
const INTERNAL_ID_PATTERN = /\b(?:prop|cmt|probe|sig|task|acc|cev|reply|fb)-[0-9a-f-]{8,}\b/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export class ReplyServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Audience filter. It is deliberately conservative: hiding a benign path costs
// a little readability, leaking one costs the user's trust.
export function filterForAudience(text, { audience = 'private', maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!AUDIENCES.includes(audience)) {
    throw new ReplyServiceError('audience_invalid', `audience must be one of ${AUDIENCES.join(', ')}`);
  }
  let out = String(text ?? '');
  out = out.replace(/[A-Za-z]:\\[^\s"'`]+/g, '[路径已隐藏]');
  out = out.replace(/(?:\/[\w.@-]+){2,}/g, '[路径已隐藏]');
  out = out.replace(/\b(?:sk|ghp|xox[bp]|wfc)-[A-Za-z0-9_-]{10,}\b/g, '[凭据已隐藏]');
  out = out.replace(/\b(?:Bearer|token|secret|password)\s*[:=]\s*\S+/gi, '[凭据已隐藏]');
  // Internal identifiers mean nothing outside Workflow and reveal structure.
  if (audience === 'group') {
    out = out.replace(INTERNAL_ID_PATTERN, '[内部标识已隐藏]').replace(UUID_PATTERN, '[内部标识已隐藏]');
  }
  const compact = out.replace(/\s+/g, ' ').trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
}

function parseTarget(channelTarget) {
  const text = String(channelTarget ?? '');
  const [channel, kind, ...rest] = text.split(':');
  const id = rest.join(':');
  if (channel !== 'feishu' || !id || !['chat', 'user'].includes(kind)) {
    throw new ReplyServiceError('channel_target_invalid', `unsupported channel target: ${text || '(empty)'}`);
  }
  return {
    channel, kind, id,
    receiveIdType: kind === 'chat' ? 'chat_id' : 'open_id',
    audience: kind === 'chat' ? 'group' : 'private',
  };
}

export const REPLY_POLICY_KEY = 'reply.policy';

export function createReplyService({
  replyRepository, proposalService, settingsRepository = null, feishuClient = null, log = () => {},
} = {}) {
  if (!replyRepository) throw new TypeError('replyRepository is required');
  if (!proposalService) throw new TypeError('proposalService is required');

  // Kill switch: a global off, or a per-target off. Missing configuration means
  // "allowed", so a fresh install does not silently refuse to speak.
  function policy() {
    const saved = settingsRepository?.get(REPLY_POLICY_KEY) ?? {};
    return {
      global: saved.global !== false,
      channels: saved.channels && typeof saved.channels === 'object' ? saved.channels : {},
    };
  }

  // The kill switch is a setting, so it can be flipped without a redeploy.
  function setPolicy(patch = {}) {
    const current = policy();
    const next = {
      global: patch.global === undefined ? current.global : Boolean(patch.global),
      channels: patch.channels && typeof patch.channels === 'object'
        ? { ...current.channels, ...patch.channels }
        : current.channels,
    };
    settingsRepository?.set(REPLY_POLICY_KEY, next);
    return next;
  }

  function assertAllowed(channelTarget) {
    const current = policy();
    if (!current.global) throw new ReplyServiceError('reply_disabled', 'autonomous replies are disabled globally');
    if (current.channels[channelTarget] === false) {
      throw new ReplyServiceError('reply_disabled', `autonomous replies are disabled for ${channelTarget}`);
    }
    return current;
  }

  async function send({ proposalId, autonomy = 'user' } = {}) {
    const proposal = proposalService.get(proposalId);
    if (!proposal) throw new ReplyServiceError('proposal_not_found', 'proposal does not exist');
    // The tier travels with the proposal and is not overridable: a caller must
    // not be able to upgrade an estimate into an auto-sendable fact.
    const effectiveTier = proposal.tier ?? 'T2';
    if (!REPLY_TIERS.includes(effectiveTier)) {
      throw new ReplyServiceError('tier_invalid', `tier must be one of ${REPLY_TIERS.join(', ')}`);
    }
    if (!AUTO_TIERS.includes(effectiveTier)) {
      throw new ReplyServiceError('tier_not_autonomous', `${effectiveTier} may not be sent autonomously`);
    }
    if (proposal.state !== 'approved') {
      throw new ReplyServiceError('PROPOSAL_NOT_APPROVED', 'only an approved proposal can be sent');
    }
    const already = replyRepository.forProposal(proposalId);
    if (already) return { reply: already, sent: false };
    if (!proposal.draftText) throw new ReplyServiceError('draft_required', 'proposal has no draft text');
    if (!feishuClient) throw new ReplyServiceError('channel_unavailable', 'no channel client is configured');
    const target = parseTarget(proposal.channelTarget);
    assertAllowed(proposal.channelTarget);
    const text = filterForAudience(proposal.draftText, { audience: target.audience });
    if (!text) throw new ReplyServiceError('draft_empty', 'draft text is empty after audience filtering');

    const reply = replyRepository.record({
      proposalId, channel: target.channel, channelTarget: proposal.channelTarget,
      tier: effectiveTier, autonomy, evidence: proposal.evidence, text,
    });
    try {
      const sent = await feishuClient.sendText(target.id, text, { receiveIdType: target.receiveIdType });
      return { reply: replyRepository.attachMessageRef(reply.replyId, sent?.message_id ?? null), sent: true };
    } catch (error) {
      log(`[replies] ${reply.replyId} failed to send: ${error.message}`);
      throw new ReplyServiceError('send_failed', error.message);
    }
  }

  // The veto sweep calls this: an approved proposal whose window elapsed is
  // sent exactly once, and only when it carries a draft and a target.
  async function sendApproved() {
    const sent = [];
    for (const proposal of proposalService.list({ state: 'approved', limit: 100 })) {
      if (!proposal.draftText || !proposal.channelTarget) continue;
      // T3 is never auto-sent, even after approval: it carries estimates and
      // promises that only the user may voice.
      if (!AUTO_TIERS.includes(proposal.tier ?? 'T2')) continue;
      if (replyRepository.forProposal(proposal.proposalId)) continue;
      try {
        const result = await send({
          proposalId: proposal.proposalId,
          autonomy: proposal.decision === 'timeout' ? 'timeout' : 'user',
        });
        if (result.sent) sent.push(result.reply);
      } catch (error) {
        log(`[replies] ${proposal.proposalId} not sent: ${error.message}`);
      }
    }
    return sent;
  }

  function recordVeto(proposalId) {
    return replyRepository.addFeedback({
      subjectType: 'proposal', subjectRef: proposalId, signal: 'veto', source: 'user',
    });
  }

  return {
    send,
    sendApproved,
    recordVeto,
    policy,
    setPolicy,
    list: (options) => replyRepository.list(options),
    filterForAudience,
  };
}
