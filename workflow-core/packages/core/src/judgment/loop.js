// judgment/loop.js - the judgment half of the brain.
//
// The commitment model already decides *when* a responsibility is allowed to
// interrupt the user. This loop decides whether it still should, and phrases
// it: a responsibility that has been stale for a week is not automatically
// worth a notification today, and the model is the thing that can tell the
// difference. Its output is a proposal, never a message.
import { extractJsonArray } from '../ai/json-array.js';

export const MAX_JUDGED_PER_TICK = 20;

const SYSTEM_PROMPT = [
  '你是 Workflow 的判断层。下面是一批到期、且按注意力策略允许打扰用户的责任（commitment）。',
  '对每一条判断：现在是否真的值得打扰用户？',
  '值得的，写一个 title（短，说清是什么）和一个 ask（一句话，说清要用户决定什么）。',
  '不值得打扰的，直接不要列出来——宁可少打扰，也不要制造噪音。',
  '只输出 JSON 数组，每项 {commitment_id, title, ask, urgency}，urgency 取 low|normal|high。',
  '没有值得打扰的，输出 []。不要解释。',
].join('\n');

export function createJudgmentLoop({
  commitmentService, proposalService, serverLlm, log = () => {},
  maxPerTick = MAX_JUDGED_PER_TICK,
} = {}) {
  if (!commitmentService) throw new TypeError('commitmentService is required');
  if (!proposalService) throw new TypeError('proposalService is required');
  const bounded = Math.min(100, Math.max(1, Number(maxPerTick) || MAX_JUDGED_PER_TICK));

  async function tick({ at = null } = {}) {
    const due = commitmentService.dueForAttention({ at });
    if (!due.length) return { due: 0, raised: 0, reason: 'nothing_due' };
    if (!serverLlm?.status?.enabled) {
      // Do not consume the cycle: when the model is back, these are still due.
      return { due: due.length, raised: 0, reason: 'llm_disabled' };
    }

    const input = due.slice(0, bounded).map(({ commitment, reason }) => ({
      commitment_id: commitment.commitmentId,
      statement: commitment.statement,
      project_id: commitment.projectId,
      due_at: commitment.dueAt,
      updated_at: commitment.updatedAt,
      attention_reason: reason,
    }));

    let reply;
    try {
      reply = await serverLlm.ask([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(input) },
      ]);
    } catch (error) {
      log(`[judgment] model call failed: ${error.message}`);
      return { due: due.length, raised: 0, reason: 'model_failed' };
    }

    const raised = [];
    for (const item of extractJsonArray(reply).slice(0, bounded)) {
      const commitment = commitmentService.get(String(item.commitment_id ?? ''));
      if (!commitment || commitment.state !== 'active') continue;
      const title = String(item.title ?? '').trim();
      const ask = String(item.ask ?? '').trim();
      if (!title || !ask) continue;
      const proposal = proposalService.open({
        source_type: 'commitment',
        source_ref: commitment.commitmentId,
        project_id: commitment.projectId,
        title,
        ask,
        urgency: ['low', 'normal', 'high'].includes(item.urgency) ? item.urgency : 'normal',
        // A responsibility reminder is a question for the user, never a reply
        // the assistant may send on its own.
        tier: 'T3',
      }).proposal;
      commitmentService.markAttention(commitment.commitmentId);
      raised.push({ commitmentId: commitment.commitmentId, proposalId: proposal.proposalId });
    }

    // Every commitment that was looked at counts as evaluated for this cycle,
    // so the next tick does not re-ask about the same thing.
    for (const { commitment } of due) commitmentService.markEvaluated(commitment.commitmentId, at ?? undefined);

    return { due: due.length, raised: raised.length, proposals: raised };
  }

  return { tick };
}
