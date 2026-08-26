// e2e.test.mjs - real Core + real Worker + fake JSONL bridge process.
// Verifies the only execution chain: HTTP task -> Core -> /worker ->
// workflow-jsonl backend -> events + terminal result back in Core.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startCore } from '../../core/src/index.js';
import { AuthRepository } from '../../core/src/auth/repository.js';
import { startWorker } from '../src/index.js';

const FAKE_BRIDGE = `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'run' || msg.type === 'resume') {
    const sessionRef = 'e2e-session-' + process.pid;
    console.log(JSON.stringify({ type: 'session', session_ref: sessionRef }));
    console.log(JSON.stringify({ type: 'event', event: { type: 'assistant_message', text: 'hello from bridge for ' + msg.task_id } }));
    console.log(JSON.stringify({ type: 'progress', note: 'working', percent: 50 }));
    console.log(JSON.stringify({ type: 'result', kind: 'done', session_ref: sessionRef, result: { summary: 'e2e-complete', task_id: msg.task_id } }));
  } else if (msg.type === 'cancel') {
    process.exit(0);
  }
});
`;

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

let dir;
let bridgePath;
let core;
let base;
let adminToken;
let workerToken;
let worker;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-e2e-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  bridgePath = path.join(dir, 'fake-bridge.mjs');
  fs.writeFileSync(bridgePath, FAKE_BRIDGE);

  const auth = new AuthRepository({ dataDir });
  await auth.createAccount({ email: 'e2e@example.com', password: 'correct-horse-battery' });
  auth.close();

  const [httpsPort, internalPort] = [await freePort(), await freePort()];
  core = await startCore({
    WFC_DATA_DIR: dataDir,
    WFC_ALLOW_PLAIN_HTTP: '1',
    WFC_HTTPS_PORT: String(httpsPort),
    WFC_INTERNAL_PORT: String(internalPort),
    WFC_CLAIM_TIMEOUT_MS: '60000',
  }, { log: () => {} });
  base = `http://127.0.0.1:${core.publicServer.address().port}`;

  const login = await fetch(`${base}/api/v1/auth/client-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'e2e@example.com', password: 'correct-horse-battery' }),
  });
  adminToken = (await login.json()).access_token;
  const created = await fetch(`${base}/api/v1/admin/tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subject_id: 'e2e-worker', role: 'worker', project_ids: [] }),
  });
  workerToken = (await created.json()).token;

  worker = await startWorker({
    coreUrl: base,
    token: workerToken,
    workerId: 'e2e-worker',
    capabilities: ['workflow-jsonl'],
    projects: [], backends: [],
    maxConcurrency: 2,
    stateDir: path.join(dir, 'worker-state'),
    version: '0.2.0-e2e',
    jsonlCommand: process.execPath,
    jsonlArgs: [bridgePath],
    adminEnabled: false, adminPort: 0, adminToken: null,
  }, { log: () => {} });
});

after(async () => {
  await worker?.stop();
  await core?.shutdown();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('HTTP task flows through /worker to the JSONL bridge and completes', async () => {
  const created = await fetch(`${base}/api/v1/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ type: 'workflow.run', brief: { goal: 'e2e goal' }, backend_kind: 'workflow-jsonl' }),
  });
  const taskId = (await created.json()).task.task_id;

  let detail = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const response = await fetch(`${base}/api/v1/tasks/${taskId}`, { headers: { authorization: `Bearer ${adminToken}` } });
    detail = await response.json();
    const task = detail.task ?? detail;
    if (['done', 'failed', 'cancelled'].includes(task?.status)) break;
  }
  const task = detail.task ?? detail;
  assert.equal(task.status, 'done');
  assert.equal(task.result?.summary, 'e2e-complete');
  assert.match(task.session_ref, /^e2e-session-/);

  const events = core.taskRepository.events(taskId);
  const texts = events.map((e) => e.payload?.text ?? e.payload?.event?.text ?? null);
  assert.ok(texts.includes(`hello from bridge for ${taskId}`), `expected bridge event, got ${JSON.stringify(texts)}`);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('session_event'));
  assert.ok(types.includes('done'));
});
