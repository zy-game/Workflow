import http from 'node:http';

const DSH_PREFIX = '/dsh';
const DSH_API_PREFIX = `${DSH_PREFIX}/api`;
const DSH_WEBSOCKET_PATHS = new Set([
  `${DSH_API_PREFIX}/events.mux`,
  `${DSH_API_PREFIX}/events.host`,
]);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
]);

function pathnameOf(request) {
  try {
    return new URL(request.url, 'http://local').pathname;
  } catch {
    return '/';
  }
}

function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const matched = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  return matched?.[1] ?? null;
}

function connectionHeaders(headers) {
  const value = headers.connection;
  const values = Array.isArray(value) ? value : [value];
  return new Set(values
    .filter((item) => typeof item === 'string')
    .flatMap((item) => item.split(','))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

function filteredHeaders(headers, { response = false } = {}) {
  const namedByConnection = connectionHeaders(headers);
  const filtered = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lower) || namedByConnection.has(lower)) continue;
    if (CREDENTIAL_HEADERS.has(lower) || lower === 'host') continue;
    if (response && lower === 'set-cookie') continue;
    filtered[lower] = value;
  }
  return filtered;
}

function sendJson(response, status, code, message) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ ok: false, code, error: message });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function socketResponse(socket, status, code, message) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ ok: false, code, error: message });
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: application/json; charset=utf-8\r\n'
    + 'Cache-Control: no-store\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    + body,
  );
}

function serializeHeaders(headers) {
  const lines = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) lines.push(`${name}: ${item}`);
    }
  }
  return lines;
}

export function createDshGateway({ authRepository, upstream, log = () => {} } = {}) {
  if (!authRepository) throw new TypeError('authRepository is required');
  const target = upstream instanceof URL ? upstream : new URL(upstream);
  const requests = new Set();
  const tunnelSockets = new Set();

  function authenticate(request) {
    const token = bearerToken(request);
    if (!token?.startsWith('wfc-')) return null;
    return authRepository.getClientAccessToken(token);
  }

  function matchesHttp(request) {
    const pathname = pathnameOf(request);
    return pathname === DSH_API_PREFIX || pathname.startsWith(`${DSH_API_PREFIX}/`);
  }

  function claimsUpgrade(request) {
    const pathname = pathnameOf(request);
    return pathname === DSH_PREFIX || pathname.startsWith(`${DSH_PREFIX}/`);
  }

  function upstreamPath(request) {
    return request.url.slice(DSH_PREFIX.length) || '/';
  }

  function requestOptions(request, headers) {
    return {
      protocol: target.protocol,
      hostname: target.hostname === '[::1]' ? '::1' : target.hostname,
      port: target.port || 80,
      method: request.method,
      path: upstreamPath(request),
      headers: { ...headers, host: target.host },
      agent: false,
    };
  }

  function trackRequest(proxyRequest) {
    requests.add(proxyRequest);
    proxyRequest.once('close', () => requests.delete(proxyRequest));
  }

  function handleHttp(request, response) {
    if (!authenticate(request)) {
      sendJson(response, 401, 'invalid_client_token', 'client bearer token is missing, invalid, expired, or revoked');
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const headers = filteredHeaders(request.headers);
      const proxyRequest = http.request(requestOptions(request, headers), (proxyResponse) => {
        const responseHeaders = filteredHeaders(proxyResponse.headers, { response: true });
        response.writeHead(proxyResponse.statusCode || 502, responseHeaders);
        proxyResponse.pipe(response);
        proxyResponse.once('end', resolve);
        proxyResponse.once('error', (error) => {
          log(`[dsh-gateway] upstream response failed: ${error.message}`);
          response.destroy(error);
          resolve();
        });
      });
      trackRequest(proxyRequest);
      proxyRequest.once('error', (error) => {
        log(`[dsh-gateway] upstream request failed: ${error.message}`);
        sendJson(response, 502, 'dsh_upstream_unavailable', 'DSH upstream is unavailable');
        resolve();
      });
      request.once('aborted', () => proxyRequest.destroy());
      response.once('close', () => {
        if (!response.writableEnded) proxyRequest.destroy();
      });
      request.pipe(proxyRequest);
    });
  }

  function handleUpgrade(server) {
    server.on('upgrade', (request, socket, head) => {
      if (!claimsUpgrade(request)) return;
      const pathname = pathnameOf(request);
      if (!DSH_WEBSOCKET_PATHS.has(pathname)) {
        socketResponse(socket, 404, 'not_found', 'DSH WebSocket endpoint is not allowed');
        return;
      }
      if (!authenticate(request)) {
        socketResponse(socket, 401, 'invalid_client_token', 'client bearer token is missing, invalid, expired, or revoked');
        return;
      }

      const headers = filteredHeaders(request.headers);
      headers.connection = 'Upgrade';
      headers.upgrade = 'websocket';
      const proxyRequest = http.request(requestOptions(request, headers));
      trackRequest(proxyRequest);

      const closePending = () => proxyRequest.destroy();
      socket.once('close', closePending);
      socket.once('error', closePending);

      proxyRequest.once('upgrade', (proxyResponse, upstreamSocket, upstreamHead) => {
        socket.off('close', closePending);
        socket.off('error', closePending);
        const responseHeaders = filteredHeaders(proxyResponse.headers, { response: true });
        responseHeaders.connection = 'Upgrade';
        responseHeaders.upgrade = 'websocket';
        const status = proxyResponse.statusCode || 101;
        const lines = [
          `HTTP/1.1 ${status} ${proxyResponse.statusMessage || http.STATUS_CODES[status] || 'Switching Protocols'}`,
          ...serializeHeaders(responseHeaders),
          '',
          '',
        ];
        socket.write(lines.join('\r\n'));
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);

        tunnelSockets.add(socket);
        tunnelSockets.add(upstreamSocket);
        const untrack = () => {
          tunnelSockets.delete(socket);
          tunnelSockets.delete(upstreamSocket);
        };
        socket.once('close', untrack);
        upstreamSocket.once('close', untrack);
        socket.once('error', () => upstreamSocket.destroy());
        upstreamSocket.once('error', () => socket.destroy());
        socket.pipe(upstreamSocket).pipe(socket);
      });

      proxyRequest.once('response', (proxyResponse) => {
        const status = proxyResponse.statusCode || 502;
        const responseHeaders = filteredHeaders(proxyResponse.headers, { response: true });
        responseHeaders.connection = 'close';
        const lines = [
          `HTTP/1.1 ${status} ${proxyResponse.statusMessage || http.STATUS_CODES[status] || 'Error'}`,
          ...serializeHeaders(responseHeaders),
          '',
          '',
        ];
        socket.write(lines.join('\r\n'));
        proxyResponse.pipe(socket);
      });

      proxyRequest.once('error', (error) => {
        log(`[dsh-gateway] upstream WebSocket failed: ${error.message}`);
        socketResponse(socket, 502, 'dsh_upstream_unavailable', 'DSH upstream is unavailable');
      });
      proxyRequest.end();
    });
  }

  function stop() {
    for (const request of requests) request.destroy();
    for (const socket of tunnelSockets) socket.destroy();
    requests.clear();
    tunnelSockets.clear();
  }

  return { matchesHttp, claimsUpgrade, handleHttp, handleUpgrade, stop };
}
