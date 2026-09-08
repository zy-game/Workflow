// memory/digest.js - the bounded input the keeper reasons over.
//
// The keeper must not scan the whole system: it gets a fixed-size snapshot of
// what changed recently and nothing else. Everything here is logical data - no
// paths, no credentials, no message bodies.
export const MAX_DIGEST_ITEMS = 40;

export function createMemoryDigest({
  commitmentRepository = null, taskRepository = null, proposalService = null, limit = MAX_DIGEST_ITEMS,
} = {}) {
  const bounded = Math.min(200, Math.max(1, Number(limit) || MAX_DIGEST_ITEMS));
  return async function digest() {
    const commitments = (commitmentRepository?.list({ limit: bounded }) ?? []).map((commitment) => ({
      id: commitment.commitmentId,
      statement: commitment.statement,
      state: commitment.state,
      project: commitment.projectId,
      dueAt: commitment.dueAt,
      updatedAt: commitment.updatedAt,
    }));
    const tasks = (taskRepository?.list?.({ limit: bounded }) ?? []).map((task) => ({
      id: task.task_id,
      type: task.type,
      status: task.status,
      project: task.project_id,
      updatedAt: task.updated_at,
    }));
    const proposals = (proposalService?.list({ limit: bounded }) ?? []).map((proposal) => ({
      id: proposal.proposalId,
      title: proposal.title,
      state: proposal.state,
      decision: proposal.decision,
      createdAt: proposal.createdAt,
    }));
    if (!commitments.length && !tasks.length && !proposals.length) return null;
    return { commitments, tasks, proposals };
  };
}
