// resolve/service.js - turning "你那个 xxxx" into a project.
//
// Three outcomes, and the third one is the point:
//   high   - exactly one project matched the words. Safe to act on.
//   medium - several matched, or the model was unsure. Ask the user, privately.
//   low    - nothing matched. Stay quiet rather than guess.
//
// Guessing wrong is the expensive failure here: a wrong project means quoting
// the wrong facts into a group chat. Uncertainty is cheap by comparison.
import { matchProjects } from './matcher.js';

export const RESOLVE_TIERS = ['high', 'medium', 'low'];
export const HIGH_CONFIDENCE = 0.75;
export const MEDIUM_CONFIDENCE = 0.4;

const SYSTEM_PROMPT = [
  '你要判断下面这句话在说哪一个项目。',
  '候选项目已给出，每个有 id、name 和描述。',
  '只输出 JSON：{"project_id": "<候选中的 id 或 null>", "confidence": 0-1, "reason": "一句话"}。',
  '不确定就输出 null 和较低的 confidence——猜错比说不确定代价高得多。不要解释。',
].join('\n');

function tierFor(confidence) {
  if (confidence >= HIGH_CONFIDENCE) return 'high';
  if (confidence >= MEDIUM_CONFIDENCE) return 'medium';
  return 'low';
}

export function createResolverService({
  knowledgeRepository, serverLlm = null, recordFeedback = null, log = () => {},
} = {}) {
  if (!knowledgeRepository) throw new TypeError('knowledgeRepository is required');

  function projects() {
    return knowledgeRepository.listProjects().map((project) => ({
      id: project.id,
      name: project.name,
      description: project.metadata?.description ?? null,
      aliases: project.metadata?.aliases ?? [],
      keywords: project.metadata?.keywords ?? [],
      metadata: project.metadata ?? {},
    }));
  }

  // Every resolution is recorded, including the ones that declined to decide:
  // the tier distribution is what the self-optimization loop tunes against.
  function note(result, { text, channelRef }) {
    if (!recordFeedback) return;
    try {
      recordFeedback({
        subjectType: 'resolution',
        subjectRef: result.projectId ?? '',
        signal: 'resolved',
        source: result.tier,
        detail: {
          confidence: result.confidence,
          reason: result.reason ?? null,
          channel: channelRef ?? null,
          text: String(text ?? '').slice(0, 200),
        },
      });
    } catch (error) {
      log(`[resolve] feedback failed: ${error.message}`);
    }
  }

  async function resolve(input = {}) {
    const result = await resolveOne(input);
    note(result, input);
    return result;
  }

  async function resolveOne({ text, channelRef = null, context = null } = {}) {
    const statement = String(text ?? '').trim();
    if (!statement) return { tier: 'low', projectId: null, confidence: 0, reason: 'empty_text' };

    const matches = matchProjects({ text: statement, projects: projects() });
    // Exactly one literal hit is the common, safe case: no model call needed.
    if (matches.length === 1) {
      return { tier: 'high', projectId: matches[0].projectId, confidence: 1, reason: `matched:${matches[0].matchedOn}` };
    }
    if (!serverLlm?.status?.enabled) {
      return {
        tier: 'low',
        projectId: null,
        confidence: 0,
        reason: matches.length ? 'ambiguous_without_model' : 'no_match',
        candidates: matches.map((match) => match.projectId),
      };
    }

    // Ambiguous or unmentioned: ask the model, but only over the candidates it
    // could plausibly mean plus the recent channel context.
    const shortlist = matches.length ? matches : [];
    let reply;
    try {
      reply = await serverLlm.ask([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ text: statement, channel: channelRef, context, candidates: shortlist }) },
      ]);
    } catch (error) {
      log(`[resolve] model call failed: ${error.message}`);
      return { tier: 'low', projectId: null, confidence: 0, reason: 'model_failed' };
    }

    const parsed = extractFirstObject(reply);
    if (!parsed) return { tier: 'low', projectId: null, confidence: 0, reason: 'unparsable_reply' };

    const confidence = Number(parsed.confidence);
    const bounded = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
    const projectId = typeof parsed.project_id === 'string' && parsed.project_id ? parsed.project_id : null;
    // A model answer naming a project that was never a candidate is not trusted.
    if (projectId && !shortlist.some((match) => match.projectId === projectId)) {
      return { tier: 'low', projectId: null, confidence: 0, reason: 'unknown_candidate' };
    }
    if (!projectId) return { tier: 'low', projectId: null, confidence: bounded, reason: 'no_project' };
    return {
      tier: tierFor(bounded), projectId, confidence: bounded,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
    };
  }

  return { resolve, resolveOne, match: (text) => matchProjects({ text, projects: projects() }), projects };
}

function extractFirstObject(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
