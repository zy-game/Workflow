// server.js - Workflow Core HTTP surface: auth, task API, admin API, health.
// The public listener is HTTPS in production; tests may pass tls=null for a
// plain loopback listener. Routing is a small path-pattern table over node:http.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseCookies, serializeSessionCookie, serializeSessionCookieClear, SESSION_COOKIE_NAME, verifyPassword } from '../auth/crypto.js';
import { frame } from '@workflow-core/shared';
import { ADMIN_HTML } from '../admin/console.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
const CLIENT_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function actionsAllow(actions, action) {
  if (!Array.isArray(actions)) return false;
  return actions.includes('*') || actions.includes(action) || actions.includes(`${action.split(':')[0]}:*`);
}

export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      const names = [];
      const regex = new RegExp(`^${pattern.replace(/:[A-Za-z0-9_]+/g, (match) => {
        names.push(match.slice(1));
        return '([^/]+)';
      })}$`);
      routes.push({ method, regex, names, handler });
    },
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const captured = route.regex.exec(pathname);
        if (!captured) continue;
        const params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(captured[index + 1])]));
        return { handler: route.handler, params };
      }
      return null;
    },
  };
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'body_too_large', 'request body exceeds the size limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_json', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createCoreServer({ config = {}, authRepository, taskRepository, workersRegistry = null, modelRegistry = null, probeRunner = null, workerChannel = null, dshGateway = null, knowledgeRepository = null, managementAi = null, feishuService = null } = {}) {
  const router = createRouter();

  // Admin surfaces are loopback-only unless WFC_ADMIN_ALLOWED_IPS widens them.
  const allowedIps = new Set(Array.isArray(config.adminAllowedIps) ? config.adminAllowedIps : []);
  function adminIpAllowed(req) {
    const ip = req.socket.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    return allowedIps.has(ip);
  }

  function resolvePrincipal(req) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length).trim();
      if (token.startsWith('wfc-')) {
        const client = authRepository.getClientAccessToken(token);
        if (client) return client.principal;
        throw new HttpError(401, 'invalid_client_token', 'client token is invalid, expired, or revoked');
      }
      const machine = authRepository.getMachineToken(token);
      if (machine) return machine.principal;
      throw new HttpError(401, 'invalid_token', 'bearer token is invalid, expired, or revoked');
    }
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE_NAME];
    if (sessionId) {
      const session = authRepository.getBrowserSession(sessionId, req.socket.remoteAddress || '');
      if (session) return session.principal;
    }
    return null;
  }

  function requireAction(req, action) {
    const principal = resolvePrincipal(req);
    if (!principal) throw new HttpError(401, 'auth_required', `authentication required for ${action}`);
    if (!actionsAllow(principal.actions, action)) {
      throw new HttpError(403, 'forbidden', `action not permitted: ${action}`);
    }
    return principal;
  }

  function requireAdmin(req) {
    if (!adminIpAllowed(req)) throw new HttpError(403, 'forbidden', 'admin access is not allowed from this address');
    const principal = resolvePrincipal(req);
    if (!principal) throw new HttpError(401, 'auth_required', 'authentication required');
    if (!actionsAllow(principal.actions, '*')) throw new HttpError(403, 'forbidden', 'admin scope required');
    return principal;
  }

  function projectAllowed(principal, projectId) {
    if (!projectId) return true;
    return principal.project_ids?.includes('*') || principal.project_ids?.includes(projectId);
  }

  function requireProject(principal, projectId) {
    if (!projectAllowed(principal, projectId)) {
      throw new HttpError(403, 'project_forbidden', `project not permitted: ${projectId}`);
    }
  }

  function visibleKnowledgeRecord(principal, record) {
    return record && projectAllowed(principal, record.projectId);
  }

  function requireKnowledgeRecord(principal, record, entity, id) {
    if (!record) throw new HttpError(404, `${entity}_not_found`, `${entity} does not exist: ${id}`);
    requireProject(principal, record.projectId);
    return record;
  }

  function queryOptions(req) {
    const url = new URL(req.url, 'http://local');
    const value = (name) => url.searchParams.get(name);
    return {
      scope: value('scope'),
      projectId: value('project_id'),
      type: value('type'),
      kind: value('kind'),
      query: value('query') || value('q'),
      tags: value('tags'),
      status: value('status'),
      clientId: value('client_id'),
      expectedRevision: value('expected_revision'),
      all: value('all') === '1',
      cursor: value('cursor'),
      limit: value('limit'),
    };
  }

  router.add('GET', '/admin', (req, res) => {
    if (!adminIpAllowed(req)) throw new HttpError(403, 'forbidden', 'admin access is not allowed from this address');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ADMIN_HTML);
    return null;
  });

  // --- health ---
  router.add('GET', '/api/v1/health', () => {
    const feishu = feishuService
      ? feishuService.connectionStatus()
      : { enabled: false, state: 'disabled' };
    return {
      ok: !feishu.enabled || feishu.state === 'connected',
      service: 'workflow-core',
      version: 1,
      checks: {
        auth: authRepository.integrityCheck(),
        core: taskRepository.integrityCheck(),
        tasks: taskRepository.countsByStatus(),
        feishu,
        ...(workersRegistry ? { workers_online: workersRegistry.list({ onlineOnly: true }).length } : {}),
        ...(modelRegistry ? { models_enabled: modelRegistry.list().filter((entry) => entry.enabled).length } : {}),
        ...(workerChannel ? { workers_connected: workerChannel.connectedCount() } : {}),
      },
    };
  });

  // --- auth ---
  router.add('POST', '/api/v1/auth/login', async (req, res, body) => {
    const account = authRepository.getAccountByEmail(String(body.email || ''));
    const valid = account && account.status === 'active' && await verifyPassword(String(body.password || ''), account.password_hash);
    if (!valid) {
      authRepository.appendAudit({ type: 'login.failed', email: body.email ?? null, ip: req.socket.remoteAddress });
      throw new HttpError(401, 'invalid_credentials', 'email or password is incorrect');
    }
    authRepository.recordLogin(account.account_id);
    const session = authRepository.createBrowserSession(account, req.socket.remoteAddress || '', SESSION_MAX_AGE_MS);
    authRepository.appendAudit({ type: 'login.ok', account_id: account.account_id, email: account.email, ip: req.socket.remoteAddress });
    send(res, 200, { ok: true, csrf_token: session.csrf_token, account: { account_id: account.account_id, email: account.email, role: account.role } }, {
      'set-cookie': serializeSessionCookie(session.id),
    });
    return null;
  });

  router.add('POST', '/api/v1/auth/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE_NAME];
    if (sessionId) authRepository.deleteBrowserSession(sessionId);
    send(res, 200, { ok: true }, { 'set-cookie': serializeSessionCookieClear() });
    return null;
  });

  router.add('GET', '/api/v1/auth/session', (req) => {
    const principal = resolvePrincipal(req);
    if (!principal) throw new HttpError(401, 'auth_required', 'not signed in');
    return { ok: true, principal };
  });

  router.add('POST', '/api/v1/auth/client-login', async (req, res, body) => {
    const account = authRepository.getAccountByEmail(String(body.email || ''));
    const valid = account && account.status === 'active' && await verifyPassword(String(body.password || ''), account.password_hash);
    if (!valid) {
      authRepository.appendAudit({ type: 'client_login.failed', email: body.email ?? null, ip: req.socket.remoteAddress });
      throw new HttpError(401, 'invalid_credentials', 'email or password is incorrect');
    }
    authRepository.recordLogin(account.account_id);
    const issued = authRepository.createClientAccessToken(account, CLIENT_TOKEN_MAX_AGE_MS);
    authRepository.appendAudit({ type: 'client_login.ok', account_id: account.account_id, ip: req.socket.remoteAddress });
    send(res, 200, {
      ok: true, access_token: issued.token, token_type: 'bearer', expires_at: issued.expiresAt,
      account: { account_id: account.account_id, email: account.email, role: account.role },
    });
    return null;
  });

  router.add('GET', '/api/v1/auth/client-session', (req) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token.startsWith('wfc-')) throw new HttpError(401, 'auth_required', 'client bearer token required');
    const client = authRepository.getClientAccessToken(token);
    if (!client) throw new HttpError(401, 'invalid_client_token', 'client token is invalid, expired, or revoked');
    return { ok: true, principal: client.principal, expires_at: client.expires_at };
  });

  router.add('POST', '/api/v1/auth/client-logout', (req, res) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token.startsWith('wfc-')) throw new HttpError(401, 'auth_required', 'client bearer token required');
    const revoked = authRepository.revokeClientAccessToken(token);
    return { ok: true, revoked };
  });

  // --- tasks ---
  router.add('POST', '/api/v1/tasks', (req, res, body) => {
    const principal = requireAction(req, 'task:create');
    const { task, idempotent_replay } = taskRepository.create({
      ...body,
      created_by: principal.subject_id,
      project_id: body.project_id ?? (principal.project_ids?.length === 1 ? principal.project_ids[0] : null) ?? null,
    });
    if (!idempotent_replay && workerChannel) setImmediate(() => workerChannel.tryDispatch());
    return { ok: true, task, idempotent_replay };
  });

  router.add('GET', '/api/v1/tasks', (req) => {
    requireAction(req, 'task:read');
    const url = new URL(req.url, 'http://local');
    return {
      ok: true,
      tasks: taskRepository.list({
        status: url.searchParams.get('status'),
        priority: url.searchParams.has('priority') ? Number(url.searchParams.get('priority')) : null,
        project_id: url.searchParams.get('project_id'),
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100,
      }),
    };
  });

  router.add('GET', '/api/v1/tasks/:id', (req, res, body, params) => {
    requireAction(req, 'task:read');
    const task = taskRepository.get(params.id);
    if (!task) throw new HttpError(404, 'task_not_found', 'task does not exist');
    return { ok: true, task };
  });

  router.add('GET', '/api/v1/tasks/:id/events', (req, res, body, params) => {
    requireAction(req, 'task:read');
    const url = new URL(req.url, 'http://local');
    const events = taskRepository.events(params.id, {
      afterSeq: url.searchParams.has('after_seq') ? Number(url.searchParams.get('after_seq')) : -1,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 500,
      type: url.searchParams.get('type'),
    });
    return { ok: true, events };
  });

  router.add('POST', '/api/v1/tasks/claim', (req, res, body) => {
    const principal = requireAction(req, 'task:claim');
    const workerId = String(body.worker_id || principal.subject_id);
    const selector = body.selector && typeof body.selector === 'object' ? body.selector : null;
    const task = taskRepository.claim({ worker_id: workerId, selector });
    return { ok: true, task };
  });

  router.add('POST', '/api/v1/tasks/:id/renew', (req, res, body, params) => {
    requireAction(req, 'task:renew');
    const task = taskRepository.renew(params.id, String(body.claim_token || ''));
    return { ok: true, task };
  });

  router.add('POST', '/api/v1/tasks/:id/progress', (req, res, body, params) => {
    requireAction(req, 'task:progress');
    const task = taskRepository.progress(params.id, String(body.claim_token || ''), {
      note: body.note ?? null,
      percent: body.percent ?? null,
      events: Array.isArray(body.events) ? body.events : [],
    });
    return { ok: true, task };
  });

  router.add('POST', '/api/v1/tasks/:id/done', (req, res, body, params) => {
    requireAction(req, 'task:complete');
    const task = taskRepository.done(params.id, String(body.claim_token || ''), {
      kind: body.kind ?? 'done',
      result: body.result ?? null,
    });
    return { ok: true, task };
  });

  router.add('POST', '/api/v1/tasks/:id/cancel', (req, res, body, params) => {
    const principal = requireAction(req, 'task:cancel');
    const task = taskRepository.cancel(params.id, principal.subject_id);
    if (workerChannel && task.claim_worker_id) {
      workerChannel.sendToWorker(task.claim_worker_id, frame('cancel', {
        task_id: task.task_id, reason: `cancelled by ${principal.subject_id}`,
      }));
    }
    return { ok: true, task };
  });

  // --- admin: machine tokens + audit ---
  router.add('GET', '/api/v1/admin/tokens', (req) => {
    requireAdmin(req);
    return { ok: true, tokens: authRepository.listMachineTokens() };
  });

  router.add('POST', '/api/v1/admin/tokens', async (req, res, body) => {
    requireAdmin(req);
    const { token, token_id, record } = authRepository.createMachineToken({
      subject_id: String(body.subject_id || ''),
      role: String(body.role || 'worker'),
      project_ids: Array.isArray(body.project_ids) ? body.project_ids : [],
      actions: Array.isArray(body.actions) ? body.actions : [],
      expires_at: body.expires_at ?? null,
    });
    // The plaintext token is returned exactly once, never stored or logged.
    return { ok: true, token, token_id, record };
  });

  router.add('DELETE', '/api/v1/admin/tokens/:id', (req, res, body, params) => {
    requireAdmin(req);
    const record = authRepository.revokeMachineToken(params.id);
    if (!record) throw new HttpError(404, 'token_not_found', 'machine token does not exist');
    return { ok: true, record };
  });

  router.add('GET', '/api/v1/admin/audit', (req) => {
    requireAdmin(req);
    const url = new URL(req.url, 'http://local');
    return {
      ok: true,
      events: authRepository.listAudit(
        url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100,
        url.searchParams.get('type'),
      ),
    };
  });

  // --- workers (live registry) ---
  if (workersRegistry) {
    router.add('GET', '/api/v1/workers', (req) => {
      requireAction(req, 'worker:read');
      return { ok: true, workers: workersRegistry.list() };
    });
  }

  // --- model registry admin ---
  if (modelRegistry) {
    router.add('GET', '/api/v1/admin/models', (req) => {
      requireAdmin(req);
      // api_key included by design: single-operator admin surface.
      return { ok: true, models: modelRegistry.list({ includeKey: true }), revision: modelRegistry.revision };
    });

    router.add('POST', '/api/v1/admin/models', async (req, res, body) => {
      requireAdmin(req);
      const model = modelRegistry.upsert({
        model_id: body.model_id ?? null,
        provider: body.provider,
        model: body.model,
        key: body.key ?? (body.model_id ? modelRegistry.get(body.model_id, { includeKey: true })?.api_key : undefined),
        baseUrl: body.baseUrl,
        priority: body.priority ?? 5,
        enabled: body.enabled ?? true,
      });
      if (workerChannel) {
        workerChannel.broadcastModels();
        await workerChannel.syncDshModel();
      }
      authRepository.appendAudit({ type: 'model_registry.updated', actor: 'admin', reason: body.model ?? '' });
      return { ok: true, model };
    });

    router.add('DELETE', '/api/v1/admin/models/:id', (req, res, body, params) => {
      requireAdmin(req);
      modelRegistry.remove(params.id);
      workerChannel?.broadcastModels();
      authRepository.appendAudit({ type: 'model_registry.removed', actor: 'admin', reason: params.id });
      return { ok: true };
    });

    router.add('POST', '/api/v1/admin/models/:id/probe', async (req, res, body, params) => {
      requireAdmin(req);
      const entry = modelRegistry.get(params.id, { includeKey: true });
      if (!entry) throw new HttpError(404, 'model_not_found', 'model entry does not exist');
      const { probeModel } = await import('../models/probe.js');
      const outcome = await probeModel(entry);
      const updated = modelRegistry.recordProbe(params.id, outcome);
      if (workerChannel && updated.probe_status === 'ok') workerChannel.broadcastModels();
      return { ok: true, outcome, model: updated };
    });

    router.add('POST', '/api/v1/admin/models/probe-all', async (req) => {
      requireAdmin(req);
      if (!probeRunner) throw new HttpError(501, 'no_probe_runner', 'probe runner is not configured');
      const results = await probeRunner.probeAll();
      workerChannel?.broadcastModels();
      return { ok: true, results };
    });
  }

  // --- live task control (inject/cancel reach the connected worker) ---
  if (workerChannel) {
    router.add('POST', '/api/v1/tasks/:id/inject', (req, res, body, params) => {
      const principal = requireAdmin(req);
      const task = taskRepository.get(params.id);
      if (!task) throw new HttpError(404, 'task_not_found', 'task does not exist');
      if (!['dispatched', 'running'].includes(task.status)) {
        throw new HttpError(409, 'task_not_active', `task is ${task.status}`);
      }
      if (typeof body.content !== 'string' || !body.content.trim()) {
        throw new HttpError(400, 'content_required', 'inject content is required');
      }
      const delivered = workerChannel.sendToWorker(task.claim_worker_id, {
        type: 'inject', id: crypto.randomUUID(), ts: new Date().toISOString(),
        payload: { task_id: task.task_id, content: body.content, by: principal.subject_id },
      });
      if (!delivered) throw new HttpError(409, 'worker_offline', 'owning worker is not connected');
      taskRepository.appendEvent(task.task_id, 'injected', { content: body.content }, principal.subject_id);
      return { ok: true, delivered: true };
    });
  }

  async function handle(req, res) {
    try {
      if (req.wfcSurface === 'public' && dshGateway?.matchesHttp(req)) {
        await dshGateway.handleHttp(req, res);
        return;
      }
      const url = new URL(req.url, 'http://local');
      const matched = router.match(req.method, url.pathname);
      if (!matched) throw new HttpError(404, 'not_found', `no route: ${req.method} ${url.pathname}`);
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const result = await matched.handler(req, res, body, matched.params);
      if (result !== null && result !== undefined) send(res, 200, result);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      // Repository validation/state errors carry a code and map to 400;
      // anything else is a genuine server fault.
      const isRepositoryError = !(error instanceof HttpError) && typeof error.code === 'string' && error.code;
      const status = error instanceof HttpError ? error.status : error.code === 'REVISION_CONFLICT' ? 409 : isRepositoryError ? 400 : 500;
      const code = error instanceof HttpError ? error.code : isRepositoryError ? error.code : 'internal_error';
      if (status === 500) console.error('[core] request failed:', error);
      send(res, status, { ok: false, code, error: error.message });
    }
  }

  function listen({ host, port, tls, surface = tls ? 'public' : 'internal' }) {
    const handler = (req, res) => {
      req.wfcSurface = surface;
      handle(req, res).catch((error) => console.error('[core] handler crash:', error));
    };
    const server = tls
      ? https.createServer({ cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) }, handler)
      : http.createServer(handler);
    server.listen(port, host);
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
    });
  }

  // --- knowledge (workflow.db) ---
  if (knowledgeRepository) {
    function scopedOptions(req, principal) {
      const options = queryOptions(req);
      if (options.projectId) requireProject(principal, options.projectId);
      return options;
    }

    function conflictProjectId(conflict) {
      if (!conflict) return null;
      if (conflict.entityType === 'project') return conflict.entityId;
      if (conflict.entityType === 'memory') return knowledgeRepository.getMemory(conflict.entityId)?.projectId || null;
      if (conflict.entityType === 'document') return knowledgeRepository.getDocument(conflict.entityId)?.projectId || null;
      return null;
    }

    function requireChangeProject(principal, change) {
      if (!change || typeof change !== 'object') throw new HttpError(400, 'invalid_change', 'change must be an object');
      if (change.entityType === 'project') return requireProject(principal, change.entityId);
      if (change.entityType === 'memory') {
        const projectId = change.operation === 'create'
          ? change.payload?.projectId
          : knowledgeRepository.getMemory(change.entityId)?.projectId;
        return requireProject(principal, projectId);
      }
      if (change.entityType === 'document') {
        const projectId = change.operation === 'create'
          ? change.payload?.projectId
          : knowledgeRepository.getDocument(change.entityId)?.projectId;
        return requireProject(principal, projectId);
      }
      throw new HttpError(400, 'unsupported_change', `unsupported change entity: ${change.entityType}`);
    }

    router.add('POST', '/api/v1/workflow/context', (req, res, body) => {
      const principal = requireAction(req, 'knowledge:read');
      const context = knowledgeRepository.getContext({
        projectId: body.project_id || body.projectId,
        location: body.cwd || body.location,
        machine: body.machine,
        maxChars: body.max_chars ?? body.maxChars,
      });
      requireProject(principal, context.project?.id);
      return { ok: true, ...context };
    });

    router.add('GET', '/api/v1/workflow/context', (req) => {
      const principal = requireAction(req, 'knowledge:read');
      const url = new URL(req.url, 'http://local');
      const context = knowledgeRepository.getContext({
        projectId: url.searchParams.get('project_id'),
        location: url.searchParams.get('location'),
        machine: url.searchParams.get('machine'),
        maxChars: url.searchParams.has('max_chars') ? Number(url.searchParams.get('max_chars')) : undefined,
      });
      requireProject(principal, context.project?.id);
      return { ok: true, ...context };
    });

    router.add('GET', '/api/v1/workflow/projects', (req) => {
      const principal = requireAction(req, 'knowledge:read');
      return { ok: true, projects: knowledgeRepository.listProjects(queryOptions(req)).filter((item) => projectAllowed(principal, item.id)) };
    });

    router.add('POST', '/api/v1/workflow/projects/resolve', (req, res, body) => {
      const create = body.create !== false;
      const principal = requireAction(req, create ? 'knowledge:write' : 'knowledge:read');
      const existing = knowledgeRepository.resolveProject({ ...body, create: false });
      if (existing) {
        requireProject(principal, existing.id);
        return { ok: true, project: existing };
      }
      if (!create) return { ok: true, project: null };
      if (!principal.project_ids?.includes('*') && !principal.project_ids?.includes(body.projectId)) {
        throw new HttpError(403, 'project_forbidden', 'creating a project requires wildcard scope or an allowed explicit projectId');
      }
      return { ok: true, project: knowledgeRepository.resolveProject(body) };
    });

    router.add('GET', '/api/v1/workflow/projects/:id', (req, res, body, params) => {
      const principal = requireAction(req, 'knowledge:read');
      const project = knowledgeRepository.getProject(params.id);
      if (!project) throw new HttpError(404, 'project_not_found', `project does not exist: ${params.id}`);
      requireProject(principal, project.id);
      return { ok: true, project };
    });

    router.add('PATCH', '/api/v1/workflow/projects/:id', (req, res, body, params) => {
      const principal = requireAction(req, 'knowledge:write');
      const project = knowledgeRepository.getProject(params.id);
      if (!project) throw new HttpError(404, 'project_not_found', `project does not exist: ${params.id}`);
      requireProject(principal, project.id);
      const { expected_revision: expectedRevision, client_id: clientId, ...patch } = body;
      return { ok: true, project: knowledgeRepository.updateProject(params.id, patch, { expectedRevision, clientId }) };
    });

    router.add('POST', '/api/v1/workflow/projects/:id/locations', (req, res, body, params) => {
      const principal = requireAction(req, 'knowledge:write');
      const project = knowledgeRepository.getProject(params.id);
      if (!project) throw new HttpError(404, 'project_not_found', `project does not exist: ${params.id}`);
      requireProject(principal, project.id);
      return { ok: true, project: knowledgeRepository.addProjectLocation(params.id, body) };
    });

    router.add('GET', '/api/v1/workflow/memories', (req) => {
      const principal = requireAction(req, 'knowledge:read');
      const options = scopedOptions(req, principal);
      const memories = options.query
        ? knowledgeRepository.searchMemories(options)
        : knowledgeRepository.listMemories(options);
      return { ok: true, memories: memories.filter((item) => visibleKnowledgeRecord(principal, item)) };
    });

    router.add('GET', '/api/v1/workflow/memories/search', (req) => {
      const principal = requireAction(req, 'knowledge:read');
      const options = scopedOptions(req, principal);
      return { ok: true, memories: knowledgeRepository.searchMemories(options).filter((item) => visibleKnowledgeRecord(principal, item)) };
    });

    router.add('GET', '/api/v1/workflow/memories/:id', (req, res, body, params) => {
      const principal = requireAction(req, 'knowledge:read');
      return { ok: true, memory: requireKnowledgeRecord(principal, knowledgeRepository.getMemory(params.id), 'memory', params.id) };
    });

    router.add('POST', '/api/v1/workflow/memories', (req, res, body) => {
      const principal = requireAction(req, 'knowledge:write');
      requireProject(principal, body.projectId);
      return { ok: true, memory: knowledgeRepository.createMemory(body) };
    });

    router.add('PATCH', '/api/v1/workflow/memories/:id', (req, res, body, params) => {
      const principal = requireAction(req, 'knowledge:write');
      requireKnowledgeRecord(principal, knowledgeRepository.getMemory(params.id), 'memory', params.id);
      const { expected_revision: expectedRevision, client_id: clientId, ...patch } = body;
      return { ok: true, memory: knowledgeRepository.updateMemory(params.id, patch, { expectedRevision, clientId }) };
    });

    router.add('DELETE', '/api/v1/workflow/memories/:id', (req, res, body, params) => {
      const principal = requireAction(req, 'knowledge:write');
      requireKnowledgeRecord(principal, knowledgeRepository.getMemory(params.id), 'memory', params.id);
      const options = queryOptions(req);
      return { ok: true, memory: knowledgeRepository.deleteMemory(params.id, { expectedRevision: options.expectedRevision, clientId: options.clientId }) };
    });

    router.add('GET', '/api/v1/workflow/documents', (req) => {
      const principal = requireAction(req, 'knowledge:read');
      const options = scopedOptions(req, principal);
      return { ok: true, documents: knowledgeRepository.listDocuments(options).filter((item) => visibleKnowledgeRecord(principal, item)) };
    });

    router.add('GET', '/api/v1/workflow/documents/:id', (req, res, body, params) => {
      const principal = requireAction(req, 'knowledge:read');
      return { ok: true, document: requireKnowledgeRecord(principal, knowledgeRepository.getDocument(params.id), 'document', params.id) };
    });

    router.add('POST', '/api/v1/workflow/documents', (req, res, body) => {
      const principal = requireAction(req, 'knowledge:write');
      requireProject(principal, body.projectId);
      return { ok: true, document: knowledgeRepository.createDocument(body) };
    });

    router.add('PATCH', '/api/v1/workflow/documents/:id', (req, res, body, params) => {
      const principal = requireAction(req, 'knowledge:write');
      requireKnowledgeRecord(principal, knowledgeRepository.getDocument(params.id), 'document', params.id);
      const { expected_revision: expectedRevision, client_id: clientId, ...patch } = body;
      return { ok: true, document: knowledgeRepository.updateDocument(params.id, patch, { expectedRevision, clientId }) };
    });

    router.add('DELETE', '/api/v1/workflow/documents/:id', (req, res, body, params) => {
      const principal = requireAction(req, 'knowledge:write');
      requireKnowledgeRecord(principal, knowledgeRepository.getDocument(params.id), 'document', params.id);
      const options = queryOptions(req);
      return { ok: true, document: knowledgeRepository.deleteDocument(params.id, { expectedRevision: options.expectedRevision, clientId: options.clientId }) };
    });

    router.add('GET', '/api/v1/workflow/changes', (req) => {
      const principal = requireAction(req, 'knowledge:read');
      const options = queryOptions(req);
      const allowed = principal.project_ids?.includes('*') ? undefined : (principal.project_ids || []);
      const result = knowledgeRepository.listChanges({ ...options, ...(allowed === undefined ? {} : { projectIds: allowed }) });
      return { ok: true, ...result };
    });

    router.add('POST', '/api/v1/workflow/apply-changes', (req, res, body) => {
      const principal = requireAction(req, 'knowledge:write');
      const changes = Array.isArray(body.changes) ? body.changes : [];
      for (const change of changes) requireChangeProject(principal, change);
      return { ok: true, ...knowledgeRepository.applyChanges(String(body.client_id || principal.subject_id), changes) };
    });

    router.add('GET', '/api/v1/workflow/conflicts', (req) => {
      const principal = requireAction(req, 'knowledge:read');
      const conflicts = knowledgeRepository.listConflicts(queryOptions(req))
        .filter((conflict) => projectAllowed(principal, conflictProjectId(conflict)));
      return { ok: true, conflicts };
    });

    router.add('POST', '/api/v1/workflow/conflicts/:id/resolve', (req, res, body, params) => {
      const principal = requireAction(req, 'knowledge:write');
      const conflict = knowledgeRepository.getConflict(params.id);
      if (!conflict) throw new HttpError(404, 'conflict_not_found', `conflict does not exist: ${params.id}`);
      requireProject(principal, conflictProjectId(conflict));
      return { ok: true, ...knowledgeRepository.resolveConflict(params.id, body.use) };
    });

    // Internal loopback-only context injection for DSH plugins (central or
    // worker context-proxy); mirrors the previous wf-api contract. Gated to
    // the internal listener, never the public HTTPS surface.
    router.add('POST', '/api/internal/v1/workflow/context', (req, res, body) => {
      if (req.wfcSurface !== 'internal') {
        throw new HttpError(404, 'not_found', 'no route: POST /api/internal/v1/workflow/context');
      }
      return { ok: true, ...knowledgeRepository.getContext({
        projectId: body.project_id || body.projectId,
        location: body.cwd || body.location,
        machine: body.machine,
        maxChars: body.max_chars ?? body.maxChars,
      }) };
    });
  }

  // --- management AI audit ---
  if (managementAi) {
    router.add('GET', '/api/v1/admin/decisions', (req) => {
      requireAdmin(req);
      const url = new URL(req.url, 'http://local');
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const rows = taskRepository.db.prepare('SELECT * FROM management_decisions ORDER BY ts DESC LIMIT ?').all(limit);
      return {
        ok: true,
        decisions: rows.map((row) => ({
          id: row.id, ts: row.ts, topic: row.topic,
          decision: JSON.parse(row.decision_json), applied: JSON.parse(row.applied_json), error: row.error,
        })),
      };
    });

    router.add('POST', '/api/v1/admin/ai/decide', async (req, res, body) => {
      requireAdmin(req);
      if (typeof body.situation !== 'string' || !body.situation.trim()) {
        throw new HttpError(400, 'situation_required', 'situation text is required');
      }
      const result = await managementAi.decide(body.topic || 'manual', body.situation);
      return { ok: true, ...result };
    });
  }

  // --- pending approvals (decide blocked DSH turns) ---
  if (workerChannel?.pendingApprovals) {
    router.add('GET', '/api/v1/admin/approvals', (req) => {
      requireAdmin(req);
      const url = new URL(req.url, 'http://local');
      const taskId = url.searchParams.get('task_id');
      const approvals = workerChannel.pendingApprovals(taskId ? { taskId } : {});
      return {
        ok: true,
        approvals: approvals.map((approval) => ({
          ...approval,
          task_status: taskRepository.get(approval.task_id)?.status ?? null,
        })),
      };
    });

    router.add('POST', '/api/v1/admin/approvals/:id/resolve', (req, res, body, params) => {
      const principal = requireAdmin(req);
      const decision = body.decision === 'approve' ? true : body.decision === 'deny' ? false : null;
      if (decision === null) {
        throw new HttpError(400, 'invalid_decision', "decision must be 'approve' or 'deny'");
      }
      const result = workerChannel.resolveApproval(params.id, decision, principal.subject_id);
      if (result.ok === false) throw new HttpError(404, 'approval_not_found', result.error);
      return result;
    });
  }

  // --- Feishu card callback (URL mode) ---
  if (feishuService && config.feishu?.callbacksEnabled) {
    router.add('POST', '/webhook/feishu', (req, res, body) => {
      if (!body || body.token !== config.feishu.verificationToken) {
        throw new HttpError(401, 'invalid_feishu_token', 'Feishu callback verification failed');
      }
      if (typeof body.challenge === 'string') return { challenge: body.challenge };
      const value = body?.event?.action?.value ?? body?.action?.value ?? null;
      if (!value || typeof value !== 'object') throw new HttpError(400, 'invalid_callback', 'unrecognized feishu callback');
      return feishuService.handleCardAction(value, body?.operator?.open_id ? `feishu:${body.operator.open_id}` : 'feishu-user');
    });
  }

  return { listen, handle, router, resolvePrincipal, requireAction };
}
