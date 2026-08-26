import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CoreDatabase } from '../src/db/core-db.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { ProjectAgentRegistry } from '../src/agents/registry.js';
import { WorkflowAgent } from '../src/agents/workflow-agent.js';

let dir; let db; let tasks; let agents; let workflow;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-workflow-agent-')); db = new CoreDatabase({ dataDir: dir }); tasks = new TaskRepository({ coreDb: db }); agents = new ProjectAgentRegistry({ coreDb: db }); workflow = new WorkflowAgent({ taskRepository: tasks, projectAgentsRegistry: agents }); });
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('Workflow Agent ensures a project owner and decomposes explicit subtasks', () => {
  const created = workflow.createTasks({ project_id: 'project-a', subtasks: [
    { type: 'inspect', brief: { goal: 'inspect repository' }, priority: 2 },
    { type: 'implement', brief: { goal: 'implement change' }, priority: 4 },
  ] });
  assert.equal(created.length, 2);
  const agent = agents.getByProject('project-a');
  assert.ok(agent.agent_id);
  assert.equal(created[0].agent_id, agent.agent_id);
  assert.deepEqual(created[0].worker_selector, {});
  assert.equal(tasks.events(created[0].task_id).some((event) => event.type === 'workflow_assigned'), true);
});
