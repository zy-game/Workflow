// probe/service.js - validation and lifecycle for read-only status probes.
//
// Invariants enforced here: a probe never creates a task, never touches the
// task claim/lease path, and every answer carries a verdict the caller can
// act on - including "unknown", which is a first-class result rather than a
// failure.
import { PROBE_VERDICTS } from './repository.js';

export const PROBE_MAX_QUESTION_LENGTH = 1000;
export const PROBE_MAX_REFS = 16;
export const PROBE_MIN_BUDGET_MS = 1_000;
export const PROBE_MAX_BUDGET_MS = 300_000;
export const PROBE_DEFAULT_BUDGET_MS = 60_000;

export class ProbeServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createProbeService({
  probeRepository, knowledgeRepository = null, onAnswered = null, log = () => {},
} = {}) {
  if (!probeRepository) throw new TypeError('probeRepository is required');

  function request({
    probe_id: probeId = null,
    project_id: projectId,
    channel_target: channelTarget = null,
    question,
    refs = [],
    budget_ms: budgetMs = PROBE_DEFAULT_BUDGET_MS,
    requested_by: requestedBy = null,
  } = {}) {
    if (!projectId || typeof projectId !== 'string') {
      throw new ProbeServiceError('project_id_required', 'project_id is required');
    }
    if (knowledgeRepository && !knowledgeRepository.getProject(projectId)) {
      throw new ProbeServiceError('PROJECT_NOT_FOUND', `project does not exist: ${projectId}`);
    }
    const text = String(question ?? '').trim();
    if (!text) throw new ProbeServiceError('question_required', 'question is required');
    if (text.length > PROBE_MAX_QUESTION_LENGTH) {
      throw new ProbeServiceError('question_too_long', `question exceeds ${PROBE_MAX_QUESTION_LENGTH} characters`);
    }
    const hintList = Array.isArray(refs) ? refs : [];
    if (hintList.length > PROBE_MAX_REFS) {
      throw new ProbeServiceError('refs_too_many', `refs exceeds ${PROBE_MAX_REFS} entries`);
    }
    const budget = Number(budgetMs);
    if (!Number.isSafeInteger(budget) || budget < PROBE_MIN_BUDGET_MS || budget > PROBE_MAX_BUDGET_MS) {
      throw new ProbeServiceError(
        'budget_invalid',
        `budget_ms must be an integer between ${PROBE_MIN_BUDGET_MS} and ${PROBE_MAX_BUDGET_MS}`,
      );
    }
    // Re-requesting a known probe_id returns the existing record untouched, so
    // a retried request never opens a second investigation.
    if (probeId) {
      const existing = probeRepository.get(String(probeId));
      if (existing) return { probe: existing, created: false };
    }
    const probe = probeRepository.create({
      probeId: probeId ? String(probeId) : undefined,
      projectId,
      channelTarget,
      question: text,
      refs: hintList,
      budgetMs: budget,
      requestedBy,
    });
    return { probe, created: true };
  }

  // Delivery happens on the executor's own pull (Bridge) or dispatch (Worker),
  // so a probe reaches a node behind NAT exactly like a task claim does.
  function claimForExecutor({ executorId, projectIds }) {
    const claimed = [];
    for (const probe of probeRepository.pendingForProjects(projectIds)) {
      const taken = probeRepository.claim(probe.probeId, executorId);
      if (taken) claimed.push(taken);
    }
    return claimed;
  }

  function answer({
    probeId, verdict, confidence = null, evidence = [], suggested_reply: suggestedReply = null,
  }) {
    if (!PROBE_VERDICTS.includes(verdict)) {
      throw new ProbeServiceError('verdict_invalid', `verdict must be one of ${PROBE_VERDICTS.join(', ')}`);
    }
    if (confidence != null && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
      throw new ProbeServiceError('confidence_invalid', 'confidence must be a number between 0 and 1');
    }
    const evidenceList = Array.isArray(evidence) ? evidence : [];
    if (verdict !== 'unknown' && evidenceList.length === 0) {
      // A public claim without evidence is worse than admitting uncertainty.
      throw new ProbeServiceError('evidence_required', 'a done/not_done verdict requires at least one evidence entry');
    }
    const probe = probeRepository.answer(probeId, {
      verdict, confidence, evidence: evidenceList, suggestedReply,
    });
    if (!probe) throw new ProbeServiceError('PROBE_NOT_OPEN', 'probe does not exist or is already resolved');
    // The answer is only useful once it can become a decision: hand it to the
    // caller so a reply proposal can be raised where the question came from.
    try {
      onAnswered?.(probe);
    } catch (error) {
      log(`[probe] onAnswered failed for ${probe.probeId}: ${error.message}`);
    }
    return probe;
  }

  return {
    request,
    claimForExecutor,
    release: (probeId) => probeRepository.release(probeId) > 0,
    answer,
    get: (probeId) => probeRepository.get(probeId),
    list: (options) => probeRepository.list(options),
  };
}
