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
const DEFAULT_MAX_CHARS = 600;

export class ReplyServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Audience filter. It is deliberately conservative: hiding a benign path costs
// a little readability, leaking one costs the user's trust.
export function filterForAudience(text, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  let out = String(text ?? '');
  out = out.replace(/[A-Za-z]:\\[^\s"'`]+/g, '[路径已隐藏]');
  out = out.replace(/(?:\/[\w.@-]+){2,}/g, '[路径已隐藏]');
  out = out.replace(/\b(?:sk|ghp|xox[bp]|wfc)-[A-Za-z0-9_-]{10,}\b/g, '[凭据已隐藏]');
  out = out.replace(/\b(?:Bearer|token|secret|password)\s*[:=]\s*\S+/gi, '[凭据已隐藏]');
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
  return { channel, kind, id, receiveIdType: kind === 'chat' ? 'chat_id' : 'open_id' };
}

export function createReplyService({
  replyRepository, proposalService, feishuClient = null, log = () => {},
} = {}) {
  if (!replyRepository) throw new TypeError('replyRepository is required');
  if (!proposalService) throw new TypeError('proposalService is required');

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
    const text = filterForAudience(proposal.draftText);
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
    list: (options) => replyRepository.list(options),
    filterForAudience,
  };
}
