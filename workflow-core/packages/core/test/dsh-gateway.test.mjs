import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { AuthRepository } from '../src/auth/repository.js';
import { createDshGateway } from '../src/gateway/dsh.js';
import { createCoreServer } from '../src/http/server.js';

let dir;
let auth;
let account;
let validToken;
let expiredToken;
let revokedToken;
let logoutToken;
let machineToken;
let upstream;
let upstreamWs;
let gateway;
let coreServer;
let internalServer;
let baseUrl;
let wsBaseUrl;
const observed = { http: [], upgrades: [] };

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function request(method, pathname, { token, headers = {}, body } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let bodyValue = text;
        try { bodyValue = JSON.parse(text); } catch { /* keep text */ }
        resolve({ status: res.statusCode, headers: res.headers, body: bodyValue });
      });
    });
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openWebSocket(pathname, token, headers = {}) {
  const ws = new WebSocket(`${wsBaseUrl}${pathname}`, {
    headers: { ...headers, authorization: `Bearer ${token}` },
  });
  return new Promise((resolve, reject) => {
    let opened = false;
    let firstMessage;
    const finish = () => {
      if (!opened || !firstMessage) return;
      ws.off('error', reject);
      resolve({ ws, message: firstMessage });
    };
    ws.once('open', () => {
      opened = true;
      finish();
    });
    ws.once('message', (data) => {
      firstMessage = JSON.parse(data.toString());
      finish();
    });
    ws.once('error', reject);
  });
}

function rejectedWebSocket(pathname, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const ws = new WebSocket(`${wsBaseUrl}${pathname}`, { headers });
  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.terminate();
      reject(new Error('WebSocket unexpectedly opened'));
    });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    ws.once('error', () => {});
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-dsh-gateway-'));
  auth = new AuthRepository({ dataDir: dir });
  account = await auth.createAccount({ email: 'gateway@example.com', password: 'correct-horse-battery' });
  validToken = auth.createClientAccessToken(account, 60_000).token;
  expiredToken = auth.createClientAccessToken(account, -1).token;
  revokedToken = auth.createClientAccessToken(account, 60_000).token;
  auth.revokeClientAccessToken(revokedToken);
  machineToken = auth.createMachineToken({ subject_id: 'gateway-test', role: 'admin' }).token;

  upstreamWs = new WebSocketServer({ noServer: true });
  upstreamWs.on('connection', (ws, req) => {
    ws.send(JSON.stringify({ path: req.url, kind: 'connected' }));
  });
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      observed.http.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const responseBody = JSON.stringify({ ok: true, upstreamPath: req.url });
      res.writeHead(207, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(responseBody),
        connection: 'x-response-hop',
        'x-response-hop': 'remove-me',
        'x-upstream': 'kept',
        'set-cookie': 'dsh-secret=must-not-leak',
      });
      res.end(responseBody);
    });
  });
  upstream.on('upgrade', (req, socket, head) => {
    observed.upgrades.push({ url: req.url, headers: req.headers });
    upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit('connection', ws, req));
  });
  await listen(upstream);

  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  gateway = createDshGateway({ authRepository: auth, upstream: upstreamUrl });
  const core = createCoreServer({
    config: {},
    authRepository: auth,
    taskRepository: {},
    dshGateway: gateway,
  });
  coreServer = await core.listen({ host: '127.0.0.1', port: 0, tls: null, surface: 'public' });
  internalServer = await core.listen({ host: '127.0.0.1', port: 0, tls: null, surface: 'internal' });
  gateway.handleUpgrade(coreServer);
  baseUrl = `http://127.0.0.1:${coreServer.address().port}`;
  wsBaseUrl = `ws://127.0.0.1:${coreServer.address().port}`;
});

after(async () => {
  gateway?.stop();
  for (const client of upstreamWs?.clients || []) client.terminate();
  upstreamWs?.close();
  coreServer?.closeAllConnections?.();
  internalServer?.closeAllConnections?.();
  upstream?.closeAllConnections?.();
  await Promise.all([close(coreServer), close(internalServer), close(upstream)]);
  auth?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('HTTP gateway validates a client token, preserves path/query/body, and strips credentials and hop headers', async () => {
  const response = await request('POST', '/dsh/api/host.describe?detail=full%20view', {
    token: validToken,
    headers: {
      host: 'public.example.test',
      cookie: 'session=public-secret',
      'proxy-authorization': 'Basic c2VjcmV0',
      connection: 'x-hop',
      'x-hop': 'remove-me',
      'x-kept': 'yes',
    },
    body: { type: 'client-request', rpcId: 'rpc-1' },
  });

  assert.equal(response.status, 207);
  assert.equal(response.body.upstreamPath, '/api/host.describe?detail=full%20view');
  assert.equal(response.headers['x-upstream'], 'kept');
  assert.equal(response.headers['x-response-hop'], undefined);
  assert.equal(response.headers['set-cookie'], undefined);

  assert.equal(observed.http.length, 1);
  const received = observed.http[0];
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/api/host.describe?detail=full%20view');
  assert.deepEqual(JSON.parse(received.body), { type: 'client-request', rpcId: 'rpc-1' });
  assert.equal(received.headers.authorization, undefined);
  assert.equal(received.headers.cookie, undefined);
  assert.equal(received.headers['proxy-authorization'], undefined);
  assert.equal(received.headers['x-hop'], undefined);
  assert.equal(received.headers['x-kept'], 'yes');
  assert.equal(received.headers.host, `127.0.0.1:${upstream.address().port}`);
});

test('HTTP gateway rejects missing, forged, expired, revoked, and machine tokens without touching DSH', async () => {
  const beforeCount = observed.http.length;
  const attempts = [
    request('POST', '/dsh/api/host.describe'),
    request('POST', '/dsh/api/host.describe', { token: 'wfc-forged-token-value' }),
    request('POST', '/dsh/api/host.describe', { token: expiredToken }),
    request('POST', '/dsh/api/host.describe', { token: revokedToken }),
    request('POST', '/dsh/api/host.describe', { token: machineToken }),
  ];
  for (const response of await Promise.all(attempts)) {
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'invalid_client_token');
  }
  assert.equal(observed.http.length, beforeCount);
});

test('client logout immediately blocks HTTP gateway access without touching DSH', async () => {
  logoutToken = auth.createClientAccessToken(account, 60_000).token;
  const logout = await request('POST', '/api/v1/auth/client-logout', { token: logoutToken });
  assert.equal(logout.status, 200);
  assert.equal(logout.body.revoked, true);

  const beforeCount = observed.http.length;
  const denied = await request('POST', '/dsh/api/host.describe', { token: logoutToken });
  assert.equal(denied.status, 401);
  assert.equal(observed.http.length, beforeCount);
});

test('HTTP gateway is limited to the public /dsh/api surface', async () => {
  const beforeCount = observed.http.length;
  const outsideApi = await request('GET', '/dsh/not-api', { token: validToken });
  assert.equal(outsideApi.status, 404);

  const internal = await fetch(
    `http://127.0.0.1:${internalServer.address().port}/dsh/api/host.describe`,
    { headers: { authorization: `Bearer ${validToken}` } },
  );
  assert.equal(internal.status, 404);
  assert.equal(observed.http.length, beforeCount);
});

test('WebSocket gateway proxies only events.mux and events.host and strips credentials', async () => {
  for (const endpoint of ['events.mux', 'events.host']) {
    const { ws, message } = await openWebSocket(`/dsh/api/${endpoint}?client=tui`, validToken, {
      cookie: 'session=public-secret',
      'x-kept': endpoint,
    });
    assert.deepEqual(message, { path: `/api/${endpoint}?client=tui`, kind: 'connected' });
    ws.close();
  }

  assert.equal(observed.upgrades.length, 2);
  for (const [index, upgrade] of observed.upgrades.entries()) {
    assert.equal(upgrade.url, `/api/events.${index === 0 ? 'mux' : 'host'}?client=tui`);
    assert.equal(upgrade.headers.authorization, undefined);
    assert.equal(upgrade.headers.cookie, undefined);
    assert.equal(upgrade.headers['x-kept'], index === 0 ? 'events.mux' : 'events.host');
    assert.equal(upgrade.headers.host, `127.0.0.1:${upstream.address().port}`);
  }
});

test('WebSocket auth and allowlist failures do not touch DSH', async () => {
  const beforeCount = observed.upgrades.length;
  assert.equal(await rejectedWebSocket('/dsh/api/events.mux'), 401);
  assert.equal(await rejectedWebSocket('/dsh/api/events.host', 'wfc-forged-token-value'), 401);
  assert.equal(await rejectedWebSocket('/dsh/api/events.mux', expiredToken), 401);
  assert.equal(await rejectedWebSocket('/dsh/api/events.host', revokedToken), 401);
  assert.equal(await rejectedWebSocket('/dsh/api/events.mux', logoutToken), 401);
  assert.equal(await rejectedWebSocket('/dsh/api/events.mux', machineToken), 401);
  assert.equal(await rejectedWebSocket('/dsh/api/not-approved', validToken), 404);
  assert.equal(observed.upgrades.length, beforeCount);
});
