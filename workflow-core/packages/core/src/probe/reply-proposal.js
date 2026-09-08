// probe/reply-proposal.js - the junction where a verified answer becomes a
// decision the user can make.
//
// This is the step that makes the loop real: without it a probe answer is just
// a row in a table. Three things must hold before a reply proposal is raised:
// there is a draft, there is somewhere to send it, and the verdict is a fact
// rather than "unknown".
export const VERDICT_LABELS = Object.freeze({ done: '已完成', not_done: '未完成' });
export const REPLY_VETO_MS = 30_000;

export function replyProposalFrom(probe) {
  if (!probe?.suggestedReply || !probe?.channelTarget) return null;
  const label = VERDICT_LABELS[probe.verdict];
  // "unknown" is not a fact, so it may not become a reply on the user's behalf.
  if (!label) return null;
  const question = String(probe.question ?? '').slice(0, 200);
  return {
    source_type: 'probe',
    source_ref: probe.probeId,
    project_id: probe.projectId,
    channel_target: probe.channelTarget,
    title: `回复：${question.slice(0, 60)}`,
    ask: `群里问「${question}」。执行器查证：${label}。是否以此回复？`,
    draft_text: probe.suggestedReply,
    evidence: Array.isArray(probe.evidence) ? probe.evidence : [],
    // A verdict with evidence is a T1 fact; without it the proposal may only
    // claim what is on the books (T2).
    tier: probe.evidence?.length ? 'T1' : 'T2',
    veto_ms: REPLY_VETO_MS,
  };
}
