// knowledge-bridge.js - loopback-only bridge that writes summarized knowledge
// into the Core knowledge repository on behalf of the authorized Worker.
// The Worker holds the Core worker token (playground boundary: a granted
// worker may write knowledge); the bridge exposes a single restricted
// endpoint so local tools (and the /workflow skill) can submit summaries
// without ever holding Core credentials. Auth: a per-machine token file.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HOST = '127.0.0.1';

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) { reject(new Error('request too large')); req.destroy(); }
    });
    req.on('end', () => { if (req.destroyed) return; try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

export class KnowledgeBridgeServer {
  constructor({ coreUrl, coreToken, stateDir, port = 0, token = null, log = () => {} } = {}) {
    if (!coreUrl || !coreToken) throw new TypeError('coreUrl and coreToken are required');
    this.coreUrl = coreUrl.replace(/\/$/, '');
    this.coreToken = coreToken;
    this.stateDir = path.resolve(stateDir);
    this.port = port;
    this.token = token || crypto.randomBytes(24).toString('base64url');
    this.log = log;
    this.server = null;
    this.tokenFile = path.join(this.stateDir, 'knowledge.token');
  }

  #persist() {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ port: this.address()?.port ?? this.port, token: this.token }, null, 2);
    fs.writeFileSync(this.tokenFile, payload, { mode: 0o600 });
  }

  async #submit(body) {
    const response = await fetch(`${this.coreUrl}/api/v1/workflow/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.coreToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout?.(20_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `core knowledge write failed: HTTP ${response.status}`);
    return result.memory ?? result;
  }

  async #handle(req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    const url = new URL(req.url, `http://${HOST}`);
    if (url.pathname === '/api/knowledge/status') return json(res, 200, { ok: true });
    if (url.pathname !== '/api/knowledge') return json(res, 404, { error: 'not_found' });
    const header = req.headers.authorization || '';
    if (header !== `Bearer ${this.token}`) return json(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
    let body;
    try { body = await readBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
    const projectId = String(body.projectId ?? '').trim();
    const title = String(body.title ?? '').trim();
    const content = String(body.content ?? '');
    const type = String(body.type ?? 'note');
    if (!projectId || !title || !content.trim()) return json(res, 400, { error: 'projectId, title and content are required' });
    try {
      // Core's knowledge repository uses `body` as the canonical field. Keep
      // `content` as a compatibility alias for older callers, but never rely
      // on it when writing to Core.
      const memory = await this.#submit({ projectId, title, body: content, content, type, tags: Array.isArray(body.tags) ? body.tags.map(String) : [] });
      this.log(`[knowledge-bridge] submitted "${title}" to ${projectId}`);
      return json(res, 200, { ok: true, memory: { id: memory.id, projectId: memory.projectId, title: memory.title, type: memory.type } });
    } catch (error) {
      this.log(`[knowledge-bridge] submit failed: ${error.message}`);
      return json(res, 502, { error: error.message });
    }
  }

  async start() {
    if (this.server) return this;
    this.server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, HOST, () => { this.server.removeListener('error', reject); resolve(); });
    });
    this.#persist();
    this.log(`[knowledge-bridge] listening on ${HOST}:${this.address().port}; token at ${this.tokenFile}`);
    return this;
  }

  address() { return this.server?.address(); }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => { this.server = null; resolve(); });
    });
  }
}
