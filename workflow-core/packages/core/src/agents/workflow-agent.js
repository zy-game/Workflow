// Workflow is the global owner of user-facing work. This coordinator keeps
// project resolution and task decomposition in one place; Workers resolve
// project-local execution details after dispatch.
export class WorkflowAgent {
  constructor({ taskRepository, taskCreationFacade = null, projectAgentsRegistry, knowledgeRepository = null, log = () => {} } = {}) {
    this.tasks = taskRepository;
    this.creation = taskCreationFacade;
    this.agents = projectAgentsRegistry;
    this.knowledge = knowledgeRepository;
    this.log = log;
  }

  resolveProject(projectId) {
    if (!projectId || typeof projectId !== 'string') throw new TypeError('project_id is required');
    const project = this.knowledge?.getProject(projectId);
    if (this.knowledge && !project) {
      const error = new Error(`project does not exist: ${projectId}`);
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }
    const agent = this.agents.ensure(projectId);
    return { project, agent };
  }

  // A request can contain explicit subtasks, or a single goal. The latter is
  // deliberately deterministic; an AI may decide the decomposition before
  // calling this method without putting model output in the task authority.
  createTasks({ project_id: projectId, type = 'workflow.project_task', goal, brief = {}, subtasks = [], priority = 5, worker_selector = {}, created_by = 'workflow:agent', agent_id = null, origin_node_id = null } = {}) {
    const { agent } = this.resolveProject(projectId);
    const entries = Array.isArray(subtasks) && subtasks.length
      ? subtasks : [{ type, brief: { ...brief, ...(goal ? { goal } : {}) }, priority, worker_selector }];
    return entries.slice(0, 32).map((entry, index) => {
      const itemBrief = entry.brief && typeof entry.brief === 'object' ? entry.brief : { goal: String(entry.goal || goal || '') };
      const created = (this.creation || this.tasks).create({
        type: String(entry.type || type), title: entry.title ?? null, brief: itemBrief,
        priority: Number.isInteger(entry.priority) ? entry.priority : priority,
        worker_selector: entry.worker_selector ?? worker_selector,
        project_id: projectId, origin_node_id, agent_id: entry.agent_id ?? agent_id ?? agent.agent_id,
        created_by,
      });
      this.tasks.appendEvent(created.task.task_id, 'workflow_assigned', { project_id: projectId, agent_id: agent.agent_id, index }, created_by);
      return created.task;
    });
  }
}
