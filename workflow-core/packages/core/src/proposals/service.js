// proposals/service.js - validation and lifecycle for user decisions.
//
// The veto window means "act unless the user objects": a pending proposal
// whose deadline passes is approved by timeout, not dropped. An explicit
// rejection always wins.
export const PROPOSAL_MAX_TITLE_LENGTH = 200;
export const PROPOSAL_MAX_ASK_LENGTH = 1000;
export const PROPOSAL_MAX_VETO_MS = 300_000;
export const PROPOSAL_DEFAULT_VETO_MS = 30_000;

export class ProposalServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createProposalService({ proposalRepository, now = () => new Date() } = {}) {
  if (!proposalRepository) throw new TypeError('proposalRepository is required');

  function open({
    proposal_id: proposalId = null,
    source_type: sourceType = 'manual',
    source_ref: sourceRef = null,
    project_id: projectId = null,
    channel_target: channelTarget = null,
    title,
    ask,
    options = [],
    draft_text: draftText = null,
    evidence = [],
    urgency = 'normal',
    confidence = null,
    veto_ms: vetoMs = null,
  } = {}) {
    const heading = String(title ?? '').trim();
    if (!heading) throw new ProposalServiceError('title_required', 'title is required');
    if (heading.length > PROPOSAL_MAX_TITLE_LENGTH) {
      throw new ProposalServiceError('title_too_long', `title exceeds ${PROPOSAL_MAX_TITLE_LENGTH} characters`);
    }
    const question = String(ask ?? '').trim();
    if (!question) throw new ProposalServiceError('ask_required', 'ask is required');
    if (question.length > PROPOSAL_MAX_ASK_LENGTH) {
      throw new ProposalServiceError('ask_too_long', `ask exceeds ${PROPOSAL_MAX_ASK_LENGTH} characters`);
    }
    const optionList = Array.isArray(options) ? options : [];
    if (optionList.length > 8) throw new ProposalServiceError('options_too_many', 'options exceeds 8 entries');
    // Re-requesting a known proposal_id returns the existing record untouched,
    // so a retried request never opens a second decision.
    if (proposalId) {
      const existing = proposalRepository.get(String(proposalId));
      if (existing) return { proposal: existing, created: false };
    }
    let vetoDeadline = null;
    if (vetoMs != null) {
      const value = Number(vetoMs);
      if (!Number.isSafeInteger(value) || value < 0 || value > PROPOSAL_MAX_VETO_MS) {
        throw new ProposalServiceError('veto_ms_invalid', `veto_ms must be an integer between 0 and ${PROPOSAL_MAX_VETO_MS}`);
      }
      vetoDeadline = new Date(now().getTime() + value).toISOString();
    }
    const proposal = proposalRepository.create({
      proposalId: proposalId ? String(proposalId) : undefined,
      sourceType, sourceRef, projectId, channelTarget,
      title: heading, ask: question, options: optionList, draftText,
      evidence: Array.isArray(evidence) ? evidence : [],
      urgency, confidence, vetoDeadline,
    });
    return { proposal, created: true };
  }

  function decide({ proposalId, action, option = null }) {
    if (!['approve', 'reject'].includes(action)) {
      throw new ProposalServiceError('action_invalid', 'action must be approve or reject');
    }
    const proposal = proposalRepository.decide(proposalId, {
      state: action === 'approve' ? 'approved' : 'rejected',
      decision: 'user',
    });
    if (!proposal) throw new ProposalServiceError('PROPOSAL_NOT_OPEN', 'proposal does not exist or is already resolved');
    return proposal;
  }

  return {
    open,
    decide,
    // Approved-by-timeout proposals are returned so the caller can act on them
    // exactly once.
    expireDue: () => proposalRepository.expireDue(now().toISOString()),
    pending: () => proposalRepository.list({ state: 'pending' }),
    get: (proposalId) => proposalRepository.get(proposalId),
    list: (options) => proposalRepository.list(options),
  };
}
