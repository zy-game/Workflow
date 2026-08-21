import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { WorkflowRepository } from '../src/knowledge/repository.js';
import { createCoreServer } from '../src/http/server.js';

class WorkflowApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.code = status === 409 ? 'REVISION_CONFLICT' : 'WORKFLOW_API_REJECTED';
  }
}

function queryString(input = {}) {
  const names = { projectId: 'project_id', clientId: 'client_id', expectedRevision: 'expected_revision' };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value == null || value === '' || value === false) continue;
    query.set(names[key] || key, value === true ? '1' : String(value));
  }
  return query.toString();
}

class WorkflowApiClient {
  constructor({ baseUrl }) { this.baseUrl = baseUrl; }
  async request(method, route, options = {}) {
    const query = queryString(options.query);
    const response = await fetch(`${this.baseUrl}/api/v1/workflow${route}${query ? `?${query}` : ''}`, {
      method,
      headers: { authorization: `Bearer ${process.env.WORKFLOW_API_TOKEN}`, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new WorkflowApiError(payload.error, response.status);
    return payload;
  }
  async context(input) { return this.request('POST', '/context', { body: input }); }
  async listProjects(input = {}) { return (await this.request('GET', '/projects', { query: input })).projects || []; }
  async resolveProject(input) { return (await this.request('POST', '/projects/resolve', { body: input })).project || null; }
  async addProjectLocation(id, input) { return (await this.request('POST', `/projects/${id}/locations`, { body: input })).project; }
  async updateProject(id, patch, options = {}) { return (await this.request('PATCH', `/projects/${id}`, { body: { ...patch, expected_revision: options.expectedRevision, client_id: options.clientId } })).project; }
  async getProject(id) { return (await this.request('GET', `/projects/${id}`)).project; }
  async listMemories(input = {}) { return (await this.request('GET', '/memories', { query: input })).memories || []; }
  async searchMemories(input = {}) { return (await this.request('GET', '/memories/search', { query: input })).memories || []; }
  async getMemory(id) { return (await this.request('GET', `/memories/${id}`)).memory; }
  async createMemory(input) { return (await this.request('POST', '/memories', { body: input })).memory; }
  async updateMemory(id, patch, options = {}) { return (await this.request('PATCH', `/memories/${id}`, { body: { ...patch, expected_revision: options.expectedRevision, client_id: options.clientId } })).memory; }
  async deleteMemory(id, options = {}) { return (await this.request('DELETE', `/memories/${id}`, { query: { expectedRevision: options.expectedRevision, clientId: options.clientId } })).memory; }
  async listDocuments(input = {}) { return (await this.request('GET', '/documents', { query: input })).documents || []; }
  async getDocument(id) { return (await this.request('GET', `/documents/${id}`)).document; }
  async createDocument(input) { return (await this.request('POST', '/documents', { body: input })).document; }
  async updateDocument(id, patch, options = {}) { return (await this.request('PATCH', `/documents/${id}`, { body: { ...patch, expected_revision: options.expectedRevision, client_id: options.clientId } })).document; }
  async deleteDocument(id, options = {}) { return (await this.request('DELETE', `/documents/${id}`, { query: { expectedRevision: options.expectedRevision, clientId: options.clientId } })).document; }
  async listChanges(input = {}) { return this.request('GET', '/changes', { query: input }); }
  async applyChanges(clientId, changes) { return this.request('POST', '/apply-changes', { body: { client_id: clientId, changes } }); }
  async listConflicts(input = {}) { return (await this.request('GET', '/conflicts', { query: input })).conflicts || []; }
  async resolveConflict(id, use) { return this.request('POST', `/conflicts/${id}/resolve`, { body: { use } }); }
}

let dir;
let auth;
let tasks;
let knowledge;
let server;
let base;
let client;
let wildcardToken;
let scopedToken;
let project;
let otherProject;
let projectMemory;

function useToken(token) {
  process.env.WORKFLOW_API_TOKEN = token;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-workflow-api-'));
  auth = new AuthRepository({ dataDir: dir });
  tasks = new TaskRepository({ dataDir: dir });
  knowledge = new WorkflowRepository({ filename: path.join(dir, 'workflow.db') });
  const core = createCoreServer({
    config: {}, authRepository: auth, taskRepository: tasks, knowledgeRepository: knowledge,
  });
  server = await core.listen({ host: '127.0.0.1', port: 0, tls: null });
  base = `http://127.0.0.1:${server.address().port}`;
  client = new WorkflowApiClient({ baseUrl: base });
  wildcardToken = auth.createMachineToken({
    subject_id: 'cli-wildcard', role: 'service', project_ids: ['*'],
    actions: ['knowledge:read', 'knowledge:write'],
  }).token;
  useToken(wildcardToken);
});

after(() => {
  delete process.env.WORKFLOW_API_TOKEN;
  server.close();
  knowledge.close();
  tasks.close();
  auth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WorkflowApiClient round-trips the complete public knowledge contract', async () => {
  project = await client.resolveProject({
    path: 'C:\\work\\alpha', machine: 'test-host', name: 'alpha', type: 'nodejs', goal: 'test API',
  });
  assert.equal(project.name, 'alpha');
  assert.equal((await client.listProjects()).length, 1);
  assert.equal((await client.getProject(project.id)).id, project.id);

  project = await client.updateProject(project.id, { goal: 'updated' }, { expectedRevision: project.revision, clientId: 'test-client' });
  assert.equal(project.goal, 'updated');
  const withLocation = await client.addProjectLocation(project.id, {
    path: '/srv/alpha', machine: 'linux-host', pathFlavor: 'posix',
  });
  assert.equal(withLocation.locations.length, 2);

  projectMemory = await client.createMemory({
    scope: 'project', projectId: project.id, type: 'insight', title: 'Remote API',
    body: 'The public compatibility API is available.', tags: ['api'], keywords: ['compatibility'],
  });
  assert.equal((await client.listMemories({ projectId: project.id })).length, 1);
  assert.equal((await client.searchMemories({ projectId: project.id, query: 'compatibility' }))[0].id, projectMemory.id);
  assert.equal((await client.getMemory(projectMemory.id)).title, 'Remote API');
  projectMemory = await client.updateMemory(
    projectMemory.id, { body: 'Updated through PATCH.' },
    { expectedRevision: projectMemory.revision, clientId: 'test-client' },
  );
  assert.equal(projectMemory.body, 'Updated through PATCH.');

  let document = await client.createDocument({
    scope: 'project', projectId: project.id, kind: 'attention', slug: 'attention',
    title: 'Attention', body: 'Keep the API compatible.',
  });
  assert.equal((await client.listDocuments({ projectId: project.id }))[0].id, document.id);
  assert.equal((await client.getDocument(document.id)).body, 'Keep the API compatible.');
  document = await client.updateDocument(
    document.id, { body: 'Compatibility verified.' },
    { expectedRevision: document.revision, clientId: 'test-client' },
  );
  assert.equal(document.body, 'Compatibility verified.');

  const context = await client.context({ projectId: project.id });
  assert.equal(context.project.id, project.id);
  assert.match(context.context_text, /Updated through PATCH/);

  const changes = await client.listChanges({ cursor: 0, limit: 100 });
  assert.ok(changes.changes.some((change) => change.entityId === projectMemory.id));
  assert.ok(changes.nextCursor > 0);

  const appliedId = 'mem-applied-contract';
  const applied = await client.applyChanges('test-client', [{
    clientChangeId: 'change-1', entityType: 'memory', entityId: appliedId, operation: 'create',
    payload: { id: appliedId, scope: 'global', type: 'pattern', title: 'Applied', body: 'Created through applyChanges.' },
  }]);
  assert.equal(applied.conflicts.length, 0);
  assert.equal((await client.getMemory(appliedId)).title, 'Applied');

  const staleRevision = projectMemory.revision;
  projectMemory = knowledge.updateMemory(projectMemory.id, { body: 'Server update.' }, { expectedRevision: staleRevision });
  await assert.rejects(
    () => client.updateMemory(projectMemory.id, { body: 'Client update.' }, { expectedRevision: staleRevision, clientId: 'test-client' }),
    (error) => error instanceof WorkflowApiError && error.status === 409 && error.code === 'REVISION_CONFLICT',
  );
  const conflicts = await client.listConflicts({ clientId: 'test-client' });
  assert.equal(conflicts.length, 1);
  const resolved = await client.resolveConflict(conflicts[0].id, 'remote');
  assert.equal(resolved.conflict.status, 'resolved');

  const deletedMemory = await client.deleteMemory(appliedId, { expectedRevision: (await client.getMemory(appliedId)).revision, clientId: 'test-client' });
  assert.equal(deletedMemory.status, 'deleted');
  const deletedDocument = await client.deleteDocument(document.id, { expectedRevision: document.revision, clientId: 'test-client' });
  assert.equal(deletedDocument.status, 'deleted');
});

test('project-scoped knowledge tokens cannot read or write another project', async () => {
  useToken(wildcardToken);
  otherProject = await client.resolveProject({ path: 'C:\\work\\beta', machine: 'test-host', name: 'beta' });
  const otherMemory = await client.createMemory({
    scope: 'project', projectId: otherProject.id, type: 'constraint', title: 'Private beta', body: 'beta only',
  });
  await client.createMemory({ scope: 'global', type: 'insight', title: 'Shared global', body: 'visible to all knowledge clients' });

  scopedToken = auth.createMachineToken({
    subject_id: 'cli-alpha', role: 'service', project_ids: [project.id],
    actions: ['knowledge:read', 'knowledge:write'],
  }).token;
  useToken(scopedToken);

  const projects = await client.listProjects();
  assert.deepEqual(projects.map((item) => item.id), [project.id]);
  await assert.rejects(() => client.getMemory(otherMemory.id), (error) => error.status === 403);
  await assert.rejects(
    () => client.createMemory({ scope: 'project', projectId: otherProject.id, type: 'insight', title: 'Denied', body: 'no' }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    () => client.resolveProject({ path: 'C:\\work\\gamma', machine: 'test-host', name: 'gamma' }),
    (error) => error.status === 403,
  );

  const visibleChanges = await client.listChanges({ cursor: 0, limit: 1000 });
  assert.ok(visibleChanges.changes.some((change) => change.projectId === project.id));
  assert.ok(visibleChanges.changes.some((change) => change.projectId === null));
  assert.ok(!visibleChanges.changes.some((change) => change.projectId === otherProject.id));
});
