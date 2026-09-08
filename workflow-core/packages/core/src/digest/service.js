// digest/service.js - the daily summary of everything that was not urgent.
//
// The judgment loop raises urgent responsibilities one at a time. Everything
// else accumulates here and arrives as a single notice, because a stream of
// small interruptions is how an assistant becomes noise. An item is delivered
// once: the digest is a notice, not a recurring nag.
export const MAX_DIGEST_ITEMS = 50;

export function createDigestService({
  commitmentService, proposalService, log = () => {}, maxItems = MAX_DIGEST_ITEMS,
} = {}) {
  if (!commitmentService) throw new TypeError('commitmentService is required');
  if (!proposalService) throw new TypeError('proposalService is required');
  const bounded = Math.min(200, Math.max(1, Number(maxItems) || MAX_DIGEST_ITEMS));

  function pending() {
    return commitmentService.pendingDigest({ limit: bounded });
  }

  // Returns { built, items, proposalId }: built is false when there was
  // nothing to say, so a caller can stay quiet without creating an empty card.
  function build({ at = null } = {}) {
    const items = pending();
    if (!items.length) return { built: false, items: 0, reason: 'empty' };

    const lines = items.map((commitment, index) => {
      const project = commitment.projectId ? `（项目 ${commitment.projectId}）` : '';
      return `${index + 1}. ${commitment.statement}${project}`;
    });
    const proposal = proposalService.open({
      source_type: 'digest',
      title: `每日摘要 · ${items.length} 条`,
      ask: `这些是我注意到、但没有打扰你的事：\n${lines.join('\n')}\n\n需要处理哪一条？`,
      urgency: 'low',
      // A digest is a question for the user; it is never sent anywhere.
      tier: 'T3',
    }).proposal;

    for (const commitment of items) commitmentService.markAttention(commitment.commitmentId, at ?? undefined);
    log(`[digest] ${items.length} item(s) summarised into ${proposal.proposalId}`);
    return { built: true, items: items.length, proposalId: proposal.proposalId };
  }

  return { build, pending };
}
