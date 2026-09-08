// ai-checkup.test.mjs - the self-optimization checkup loop runs end to end:
// system metrics reach the configured LLM backend and the proposals it returns
// land in ai_suggestions as pending, behind the human-approval gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startCore } from '../src/index.js';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const PASSWORD = 'correct-horse-battery';

async function adminToken(base) {
  const response = await fetch(`${base}/api/v1/auth/client-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: PASSWORD }),
  });
  const body = await response.json();
  assert.ok(body.access_token, `login failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

test('the checkup loop stores CLI-produced proposals as pending suggestions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-checkup-'));
  const publicPort = await freePort();
  const internalPort = await freePort();
  // The CLI backend is an opaque command: it receives the transcript as its
  // last argument and must print the model reply on stdout.
  const stub = path.join(dir, 'stub-cli.mjs');
  fs.writeFileSync(stub, [
    'const transcript = process.argv[process.argv.length - 1] ?? "";',
    'if (!transcript.includes(' + JSON.stringify('"counts"') + ')) process.exit(3);',
    'process.stdout.write(JSON.stringify([',
    '  { target_type: "settings", title: "调高停滞阈值", summary: "stub", payload: { key: "rules.stale", value: { days: 6 } } },',
    ']));',
  ].join('\n'));
  let runtime;
  try {
    runtime = await startCore({
      WFC_DATA_DIR: dir,
      WFC_ALLOW_PLAIN_HTTP: '1',
      WFC_HTTPS_PORT: String(publicPort),
      WFC_INTERNAL_PORT: String(internalPort),
      WFC_LLM_BACKEND: 'cli',
      WFC_LLM_CLI_COMMAND: process.execPath,
      WFC_LLM_CLI_ARGS: JSON.stringify([stub]),
    }, { log: () => {} });
    await runtime.authRepository.createAccount({ email: 'owner@example.com', password: PASSWORD });
    const base = `http://127.0.0.1:${publicPort}`;
    const token = await adminToken(base);

    const checkup = await fetch(`${base}/api/v1/ai/checkup`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const result = await checkup.json();
    assert.equal(checkup.status, 200, `checkup failed: ${JSON.stringify(result)}`);
    assert.equal(result.ok, true);
    assert.equal(result.generated, 1);

    const list = await fetch(`${base}/api/v1/ai/suggestions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const { suggestions } = await list.json();
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].status, 'pending');
    assert.equal(suggestions[0].targetType, 'settings');
    assert.equal(suggestions[0].payload.key, 'rules.stale');
  } finally {
    await runtime?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the checkup loop reports a disabled server LLM instead of failing silently', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-checkup-off-'));
  const publicPort = await freePort();
  const internalPort = await freePort();
  let runtime;
  try {
    runtime = await startCore({
      WFC_DATA_DIR: dir,
      WFC_ALLOW_PLAIN_HTTP: '1',
      WFC_HTTPS_PORT: String(publicPort),
      WFC_INTERNAL_PORT: String(internalPort),
    }, { log: () => {} });
    await runtime.authRepository.createAccount({ email: 'owner@example.com', password: PASSWORD });
    const base = `http://127.0.0.1:${publicPort}`;
    const token = await adminToken(base);

    const checkup = await fetch(`${base}/api/v1/ai/checkup`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const result = await checkup.json();
    assert.equal(checkup.status, 200, `checkup failed: ${JSON.stringify(result)}`);
    assert.equal(result.ok, false);
    assert.match(result.reason, /server LLM is not enabled/);
  } finally {
    await runtime?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
