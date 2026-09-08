// applications.test.mjs - what a self-optimization change did, and how to undo
// it. A change to the assistant's own configuration must be reversible and
// measurable, or the loop is just a stream of opinions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { metricsDelta, SuggestionApplicationRepository } from '../src/ai/applications.js';
import { AuthRepository } from '../src/auth/repository.js';
import { CoreDatabase } from '../src/db/core-db.js';
import { createCoreServer } from '../src/http/server.js';
import { SettingsRepository } from '../src/settings/repository.js';
import { TaskRepository } from '../src/tasks/repository.js';
import { WorkersRegistry } from '../src/workers/registry.js';

let dir;
let auth;
let coreDb;
let applications;
let settings;
let workers;
let server;
let base;
let token;

const metricsWith = (rates) => ({
  proposals: { approval_rate: rates.approval ?? 0.5, rejection_rate: rates.rejection ?? 0.5 },
  resolution: { auto_rate: rates.resolution ?? 0.5 },
  replies: { veto_rate: rates.veto ?? 0.1 },
});

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-applications-'));
  auth = new AuthRepository({ dataDir: dir });
  coreDb = new CoreDatabase({ dataDir: dir });
  applications = new SuggestionApplicationRepository({ coreDb });
  settings = new SettingsRepository({ coreDb });
  workers = new WorkersRegistry({ coreDb });
  token = auth.createMachineToken({ subject_id: 'app-admin', role: 'admin' }).token;
});

after(() => {
  server?.close();
  coreDb.close();
  auth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the delta knows which direction is an improvement', () => {
  const changes = metricsDelta(
    metricsWith({ approval: 0.5, rejection: 0.5, resolution: 0.5, veto: 0.2 }),
    metricsWith({ approval: 0.7, rejection: 0.2, resolution: 0.6, veto: 0.3 }),
  );
  const byMetric = Object.fromEntries(changes.map((change) => [change.metric, change]));
  assert.equal(byMetric['proposals.approval_rate'].improved, true, 'more approvals is better');
  assert.equal(byMetric['proposals.rejection_rate'].improved, true, 'fewer rejections is better');
  assert.equal(byMetric['resolution.auto_rate'].improved, true, 'more automatic resolution is better');
  assert.equal(byMetric['replies.veto_rate'].improved, false, 'more vetoes is worse');
  assert.equal(byMetric['proposals.approval_rate'].delta, 0.2);
});

test('the delta ignores metrics it cannot compare', () => {
  assert.deepEqual(metricsDelta({}, metricsWith({})), []);
  assert.deepEqual(metricsDelta(metricsWith({}), null), []);
});

test('an application is recorded with its snapshot and metrics', () => {
  const recorded = applications.record({
    suggestionId: 'sug-1', targetType: 'settings', targetKey: 'assistant.attention',
    before: { value: { every: '1d' } }, after: { value: { every: '3d' } },
    metricsBefore: metricsWith({ rejection: 0.5 }),
  });
  assert.equal(recorded.targetKey, 'assistant.attention');
  assert.deepEqual(recorded.before, { value: { every: '1d' } });
  assert.equal(recorded.revertedAt, null);
  assert.equal(applications.list().length, 1);
});

test('a setting can be rolled back to its snapshot', async () => {
  settings.set('assistant.attention', { every: '3d' });
  const application = applications.record({
    suggestionId: 'sug-2', targetType: 'settings', targetKey: 'assistant.attention',
    before: { value: { every: '1d' } }, after: { value: { every: '3d' } },
    metricsBefore: metricsWith({}),
  });

  const app = createCoreServer({
    config: {}, authRepository: auth, taskRepository: new TaskRepository({ coreDb }),
    settingsRepository: settings, workersRegistry: workers,
    applicationRepository: applications, checkupMetrics: () => metricsWith({ rejection: 0.3 }),
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

  const listed = await call('GET', '/api/v1/ai/applications');
  assert.equal(listed.body.applications.length, 2);
  const rejection = listed.body.applications[0].delta.find((change) => change.metric === 'proposals.rejection_rate');
  assert.equal(rejection.improved, true, 'a falling rejection rate is an improvement');

  const reverted = await call('POST', `/api/v1/ai/applications/${application.applicationId}/revert`);
  assert.equal(reverted.status, 200);
  assert.deepEqual(settings.get('assistant.attention'), { every: '1d' });

  const twice = await call('POST', `/api/v1/ai/applications/${application.applicationId}/revert`);
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, 'already_reverted');

  const missing = await call('POST', '/api/v1/ai/applications/does-not-exist/revert');
  assert.equal(missing.status, 404);
});

test('a skill can be rolled back to its previous content', async () => {
  workers.upsertSkill('workflow-memory', 'new content');
  const application = applications.record({
    suggestionId: 'sug-3', targetType: 'skill', targetKey: 'workflow-memory',
    before: { content: 'old content' }, after: { content: 'new content' },
    metricsBefore: metricsWith({}),
  });
  const response = await fetch(`${base}/api/v1/ai/applications/${application.applicationId}/revert`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  assert.equal(response.status, 200);
  assert.equal(workers.listSkills().find((skill) => skill.name === 'workflow-memory').content, 'old content');
});
