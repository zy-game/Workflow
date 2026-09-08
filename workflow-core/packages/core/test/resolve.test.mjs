// resolve.test.mjs - turning "你那个 xxxx" into a project. Three outcomes, and
// the third is the point: guessing wrong means quoting the wrong facts into a
// group chat, so uncertainty must stay cheap and visible.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AuthRepository } from '../src/auth/repository.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { WorkflowRepository } from '../src/knowledge/repository.js';
import { matchProjects, normalizeText } from '../src/resolve/matcher.js';
import { createResolverService } from '../src/resolve/service.js';
import { TaskRepository } from '../src/tasks/repository.js';

let dir;
let auth;
let coreDb;
let knowledge;
let resolver;
let server;
let base;
let token;
let projectA;
let projectB;

function fakeLlm(reply, enabled = true) {
  const calls = [];
  return { calls, status: { enabled }, ask: async (messages) => { calls.push(messages); return reply; } };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-resolve-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDb = new CoreDatabase({ dataDir: dir });
  knowledge = new WorkflowRepository({ filename: path.join(dir, 'workflow.db') });
  projectA = knowledge.resolveProject({
    path: '/srv/login', machine: 'box',
    metadata: { aliases: ['登录', 'signin'], keywords: ['认证'], description: '登录与鉴权模块' },
  });
  projectB = knowledge.resolveProject({
    path: '/srv/pay', machine: 'box',
    metadata: { aliases: ['支付'], description: '支付与对账' },
  });
  token = auth.createMachineToken({ subject_id: 'resolve-admin', role: 'admin' }).token;
});

after(() => {
  server?.close();
  knowledge.close();
  coreDb.close();
  auth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('text normalisation folds punctuation, case and spacing', () => {
  assert.equal(normalizeText('你那个 登录 做好了没？'), '你那个登录做好了没');
  assert.equal(normalizeText('SignIn!'), 'signin');
  assert.equal(normalizeText('  '), '');
});

test('matching is literal and ranks the longest term', () => {
  const projects = [projectA, projectB].map((project) => knowledge.getProject(project.id));
  assert.deepEqual(matchProjects({ text: '你那个登录做好了没', projects }).map((match) => match.projectId), [projectA.id]);
  assert.deepEqual(matchProjects({ text: '支付对账', projects }).map((match) => match.projectId), [projectB.id]);
  assert.deepEqual(matchProjects({ text: '今天天气不错', projects }), []);
  // A single word that matches both is ambiguous, not a guess.
  assert.equal(matchProjects({ text: '登录和支付', projects }).length, 2);
});

test('a single literal match resolves without consulting the model', async () => {
  const llm = fakeLlm('{}');
  resolver = createResolverService({ knowledgeRepository: knowledge, serverLlm: llm });
  const result = await resolver.resolve({ text: '你那个登录做好了没' });
  assert.equal(result.tier, 'high');
  assert.equal(result.projectId, projectA.id);
  assert.equal(llm.calls.length, 0);
});

test('no match without a model stays quiet', async () => {
  resolver = createResolverService({ knowledgeRepository: knowledge, serverLlm: fakeLlm('{}', false) });
  const result = await resolver.resolve({ text: '那个东西好了没' });
  assert.equal(result.tier, 'low');
  assert.equal(result.projectId, null);
  assert.equal(result.reason, 'no_match');
});

test('an ambiguous reference is handed to the model and tiered by its confidence', async () => {
  const high = createResolverService({
    knowledgeRepository: knowledge,
    serverLlm: fakeLlm(JSON.stringify({ project_id: projectA.id, confidence: 0.9, reason: '说的是登录' })),
  });
  const resolved = await high.resolve({ text: '登录和支付那边怎么样了' });
  assert.equal(resolved.tier, 'high');
  assert.equal(resolved.projectId, projectA.id);

  const medium = createResolverService({
    knowledgeRepository: knowledge,
    serverLlm: fakeLlm(JSON.stringify({ project_id: projectB.id, confidence: 0.55 })),
  });
  assert.equal((await medium.resolve({ text: '登录和支付那边怎么样了' })).tier, 'medium');
});

test('a model answer that names a non-candidate is not trusted', async () => {
  const llm = fakeLlm(JSON.stringify({ project_id: 'some-other-project', confidence: 0.99 }));
  const service = createResolverService({ knowledgeRepository: knowledge, serverLlm: llm });
  const result = await service.resolve({ text: '登录和支付那边怎么样了' });
  assert.equal(result.tier, 'low');
  assert.equal(result.projectId, null);
  assert.equal(result.reason, 'unknown_candidate');
});

test('an unparsable or empty model answer degrades to low', async () => {
  for (const reply of ['我判断不了', JSON.stringify({ project_id: null, confidence: 0.8 })]) {
    const service = createResolverService({ knowledgeRepository: knowledge, serverLlm: fakeLlm(reply) });
    const result = await service.resolve({ text: '登录和支付那边怎么样了' });
    assert.equal(result.tier, 'low');
    assert.equal(result.projectId, null);
  }
  const empty = createResolverService({ knowledgeRepository: knowledge, serverLlm: fakeLlm('{}') });
  assert.equal((await empty.resolve({ text: '   ' })).reason, 'empty_text');
});

test('resolution is reachable over HTTP', async () => {
  const service = createResolverService({ knowledgeRepository: knowledge, serverLlm: fakeLlm('{}', false) });
  const app = createCoreServer({
    config: {}, authRepository: auth, taskRepository: new TaskRepository({ coreDb }),
    knowledgeRepository: knowledge, resolverService: service,
  });
  server = await app.listen({ host: '127.0.0.1', port: 0, tls: null });
  base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const resolved = await call('POST', '/api/v1/resolve', { text: '你那个登录做好了没' });
  assert.equal(resolved.body.tier, 'high');
  assert.equal(resolved.body.projectId, projectA.id);

  const candidates = await call('GET', '/api/v1/resolve/candidates?text=' + encodeURIComponent('支付'));
  assert.equal(candidates.body.candidates[0].projectId, projectB.id);
});
