import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
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

async function canBind(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

function runtimeEnv(dir, publicPort, internalPort, extra = {}) {
  return {
    WFC_DATA_DIR: dir,
    WFC_ALLOW_PLAIN_HTTP: '1',
    WFC_HTTPS_PORT: String(publicPort),
    WFC_INTERNAL_PORT: String(internalPort),
    ...extra,
  };
}

function rejectedWebSocket(url, token) {
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      socket.terminate();
      reject(new Error('WebSocket unexpectedly opened'));
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('error', () => {});
  });
}

test('Core starts without Feishu, reports it disabled, and shuts down cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-start-'));
  const publicPort = await freePort();
  const internalPort = await freePort();
  let runtime;
  try {
    runtime = await startCore(runtimeEnv(dir, publicPort, internalPort), { log: () => {} });
    const response = await fetch(`http://127.0.0.1:${publicPort}/api/v1/health`);
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.deepEqual(health.checks.feishu, { enabled: false, state: 'disabled' });
    await runtime.shutdown();
    runtime = null;
    assert.equal(await canBind(publicPort), true);
    assert.equal(await canBind(internalPort), true);
  } finally {
    await runtime?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Core exposes /worker as its only execution WebSocket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-start-worker-only-'));
  const publicPort = await freePort();
  const internalPort = await freePort();
  let runtime;
  let workerSocket;
  try {
    runtime = await startCore(runtimeEnv(dir, publicPort, internalPort), { log: () => {} });
    const { token } = runtime.authRepository.createMachineToken({
      subject_id: 'surface-test', role: 'worker', project_ids: ['*'],
    });

    const clientHttp = await fetch(`http://127.0.0.1:${publicPort}/client`);

    workerSocket = new WebSocket(`ws://127.0.0.1:${publicPort}/worker`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise((resolve, reject) => {
      workerSocket.once('open', resolve);
      workerSocket.once('error', reject);
    });
  } finally {
    workerSocket?.terminate();
    await runtime?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Core terminates stalled HTTP and unregistered Worker sockets during shutdown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-start-stalled-'));
  const publicPort = await freePort();
  const internalPort = await freePort();
  let runtime;
  let stalledHttp;
  let workerSocket;
  try {
    runtime = await startCore(runtimeEnv(dir, publicPort, internalPort), { log: () => {} });
    const { token } = runtime.authRepository.createMachineToken({
      subject_id: 'shutdown-test', role: 'worker',
    });

    stalledHttp = net.connect(publicPort, '127.0.0.1');
    await new Promise((resolve, reject) => {
      stalledHttp.once('connect', resolve);
      stalledHttp.once('error', reject);
    });
    stalledHttp.write('POST /api/v1/tasks HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{');

    workerSocket = new WebSocket(`ws://127.0.0.1:${publicPort}/worker`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise((resolve, reject) => {
      workerSocket.once('open', resolve);
      workerSocket.once('error', reject);
    });

    const first = runtime.shutdown();
    const second = runtime.shutdown();
    assert.equal(first, second);
    await Promise.race([
      first,
      new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown exceeded 2 seconds')), 2_000)),
    ]);
    runtime = null;
    assert.equal(await canBind(publicPort), true);
    assert.equal(await canBind(internalPort), true);
  } finally {
    workerSocket?.terminate();
    stalledHttp?.destroy();
    await runtime?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Core releases listeners and databases when Feishu startup fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-start-fail-'));
  const publicPort = await freePort();
  const internalPort = await freePort();
  const expected = new Error('simulated Feishu connection failure');
  try {
    await assert.rejects(
      startCore(runtimeEnv(dir, publicPort, internalPort, {
        WFC_FEISHU_APP_ID: 'cli_0123456789abcdef',
        WFC_FEISHU_APP_SECRET: 'secret',
      }), {
        log: () => {},
        connectFeishu: async () => { throw expected; },
      }),
      expected,
    );
    assert.equal(await canBind(publicPort), true);
    assert.equal(await canBind(internalPort), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
