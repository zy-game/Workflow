const NODE_ID_PATTERN = /^[a-z][a-z0-9._-]{2,63}$/;

export class TaskRoutingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TaskRoutingError';
    this.code = code;
  }
}

export function resolveTaskRoute({ projectId = null, originNodeId, projectOwnerNodeId = null } = {}) {
  const project_id = projectId || 'default';
  if (!originNodeId || typeof originNodeId !== 'string') {
    throw new TaskRoutingError('ORIGIN_NODE_REQUIRED', 'origin_node_id is required');
  }
  if (!NODE_ID_PATTERN.test(originNodeId)) {
    throw new TaskRoutingError('INVALID_ORIGIN_NODE', 'origin_node_id is invalid');
  }
  if (project_id === 'default') return { project_id, origin_node_id: originNodeId, executor_node_id: originNodeId };
  if (!projectOwnerNodeId) throw new TaskRoutingError('PROJECT_OWNER_REQUIRED', `project owner is required: ${project_id}`);
  if (typeof projectOwnerNodeId !== 'string' || !NODE_ID_PATTERN.test(projectOwnerNodeId)) {
    throw new TaskRoutingError('INVALID_PROJECT_OWNER', `project owner is invalid: ${project_id}`);
  }
  return { project_id, origin_node_id: originNodeId, executor_node_id: projectOwnerNodeId };
}

export class TaskCreationFacade {
  constructor({ taskRepository, knowledgeRepository = null, nodeId = null } = {}) {
    if (!taskRepository) throw new TypeError('taskRepository is required');
    this.tasks = taskRepository;
    this.knowledge = knowledgeRepository;
    this.nodeId = nodeId;
  }

  create(input = {}) {
    const projectId = input.project_id || null;
    const owner = projectId && projectId !== 'default'
      ? (this.knowledge?.getProjectOwnerNodeId?.(projectId) ?? null)
      : null;
    const route = resolveTaskRoute({
      projectId,
      originNodeId: input.origin_node_id || this.nodeId || input.created_by,
      projectOwnerNodeId: projectId && projectId !== 'default' ? owner : input.executor_node_id,
    });
    return this.tasks.create({ ...input, ...route });
  }
}
