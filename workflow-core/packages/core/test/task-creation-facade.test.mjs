import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskCreationFacade, TaskRoutingError, resolveTaskRoute } from '../src/tasks/creation-facade.js';

test('default tasks execute on their origin node', () => {
  assert.deepEqual(resolveTaskRoute({ originNodeId: 'node-origin' }), {
    project_id: 'default', origin_node_id: 'node-origin', executor_node_id: 'node-origin',
  });
});

test('project tasks preserve owner execution and separate origin', () => {
  assert.deepEqual(resolveTaskRoute({ projectId: 'project-a', originNodeId: 'node-origin', projectOwnerNodeId: 'node-owner' }), {
    project_id: 'project-a', origin_node_id: 'node-origin', executor_node_id: 'node-owner',
  });
});

test('project routing rejects missing or invalid owners', () => {
  assert.throws(() => resolveTaskRoute({ projectId: 'project-a', originNodeId: 'node-origin' }), (error) => error instanceof TaskRoutingError && error.code === 'PROJECT_OWNER_REQUIRED');
  assert.throws(() => resolveTaskRoute({ projectId: 'project-a', originNodeId: 'node-origin', projectOwnerNodeId: 'bad owner' }), (error) => error instanceof TaskRoutingError && error.code === 'INVALID_PROJECT_OWNER');
});

test('creation facade resolves owner once before repository write', () => {
  const calls = [];
  const facade = new TaskCreationFacade({
    nodeId: 'node-origin',
    knowledgeRepository: { getProjectOwnerNodeId: (id) => { calls.push(id); return 'node-owner'; } },
    taskRepository: { create: (input) => ({ task: input, idempotent_replay: false }) },
  });
  const result = facade.create({ type: 'work', brief: { goal: 'test' }, created_by: 'machine:test', project_id: 'project-a' });
  assert.deepEqual(calls, ['project-a']);
  assert.equal(result.task.origin_node_id, 'node-origin');
  assert.equal(result.task.executor_node_id, 'node-owner');
});
