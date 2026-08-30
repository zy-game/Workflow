// server.js - Workflow Core HTTP surface: auth, task API, admin API, health.
// The public listener is HTTPS in production; tests may pass tls=null for a
// plain loopback listener. Routing is a small path-pattern table over node:http.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseCookies, serializeSessionCookie, serializeSessionCookieClear, SESSION_COOKIE_NAME, verifyPassword } from '../auth/crypto.js';
import { frame } from '@workflow-core/shared';
import { ADMIN_HTML } from '../admin/console.js';
import { TaskRoutingError } from '../tasks/creation-facade.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BRIDGE_BODY_BYTES = 1024 * 1024;
const MAX_BRIDGE_EVENTS_BODY_BYTES = 512 * 1024;
const MAX_BRIDGE_IDENTIFIER_LENGTH = 128;
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

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
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

function publicEnrollment(e) {
  if (!e) return null;
  return { code: e.code, workerId: e.workerId, machine: e.machine, fingerprint: e.fingerprint ? String(e.fingerprint).slice(0, 8) + '…' : null, hasTokenPending: e.hasTokenPending, approvedAt: e.approvedAt, status: e.status, createdAt: e.createdAt, consumedAt: e.consumedAt };
}
function findFileByName(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = findFileByName(full, name); if (found) return found; }
    else if (entry.name === name) return full;
  }
  return null;
}
export function createCoreServer({ config = {}, nodeId = null, authRepository, taskRepository, taskCreationFacade = null, interactionRepository = null, workersRegistry = null, bridgeService = null, peerSyncService = null, projectAgentsRegistry = null, workflowAgent = null, workerChannel = null, knowledgeRepository = null, feishuService = null, credentialCipher = null, settingsRepository = null, serverLlm = null, suggestionsRepository = null, runCheckup = null, applySuggestion = null } = {}) {
  const router = createRouter();

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
      const session = authRepository.getBrowserSession(sessionId);
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
    const principal = resolvePrincipal(req);
    if (!principal) throw new HttpError(401, 'auth_required', 'authentication required');
    if (!actionsAllow(principal.actions, '*')) throw new HttpError(403, 'forbidden', 'admin scope required');
    return principal;
  }

  function requireBridge(req, action) {
    const principal = requireAction(req, action);
    if (principal.auth_type !== 'machine' || principal.role !== 'bridge') {
      throw new HttpError(403, 'bridge_identity_required', 'a dedicated Bridge machine token is required');
    }
    const subject = String(principal.subject_id || '');
    const bridgeId = subject.startsWith('machine:') ? subject.slice('machine:'.length) : subject;
    if (!bridgeId) throw new HttpError(403, 'bridge_identity_required', 'Bridge token has no subject identity');
    return { principal, bridgeId };
  }

  function bridgeInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'invalid_bridge_request', 'Bridge request must be a JSON object');
    }
    if (typeof body.request_id !== 'string' || !body.request_id) {
      throw new HttpError(400, 'request_id_required', 'request_id is required');
    }
    if (body.request_id.length > MAX_BRIDGE_IDENTIFIER_LENGTH) {
      throw new HttpError(400, 'request_id_too_long', `request_id exceeds the ${MAX_BRIDGE_IDENTIFIER_LENGTH} character limit`);
    }
    return { requestId: body.request_id, protocolVersion: body.protocol_version };
  }

  function sendBridge(res, outcome) {
    if (!outcome || !Number.isInteger(outcome.status)) {
      throw new Error('Bridge service returned an invalid HTTP outcome');
    }
    send(res, outcome.status, outcome.response);
    return null;
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

  function requireTaskVisible(principal, task) {
    if (!task) throw new HttpError(404, 'task_not_found', 'task does not exist');
    requireProject(principal, task.project_id);
    return task;
  }

  // The migration imported historical local skill/cache directories into the
  // repository. They remain queryable for audit, but are not business
  // projects and should not appear in the default project catalog.
  function isManagedProject(project, includeLegacy = false) {
    if (includeLegacy || !project) return true;
    if (project.metadata?.orphanedLegacyDirectory) return false;
    const systemRoots = [
      'c:/users/administrator/.agents/',
      'c:/users/administrator/.codex/',
      '/home/ubuntu/workspaces/default',
    ];
    const locations = Array.isArray(project.locations) ? project.locations : [];
    return !locations.length || !locations.every((location) => {
      const normalized = String(location.normalizedPath || '').toLowerCase();
      return systemRoots.some((root) => normalized === root || normalized.startsWith(root));
    });
  }

  function projectCatalogKey(project) {
    const systemRoots = [
      'c:/users/administrator/.agents/',
      'c:/users/administrator/.codex/',
      '/home/ubuntu/workspaces/default',
    ];
    const location = (project.locations || []).find((item) => {
      const normalized = String(item.normalizedPath || '').toLowerCase();
      return !systemRoots.some((root) => normalized === root || normalized.startsWith(root));
    });
    return location
      ? `${location.pathFlavor || 'path'}:${String(location.normalizedPath || '').toLowerCase()}`
      : `project:${project.id}`;
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

  const serveAdmin = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ADMIN_HTML);
    return null;
  };
  router.add('GET', '/admin', serveAdmin);
  router.add('GET', '/admin/', serveAdmin);

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
    // Wildcard principals are global operators, not a concrete project. Do
    // not silently turn their tasks into project-scoped client work.
    const inferredProject = principal.project_ids?.length === 1 && principal.project_ids[0] !== '*'
      ? principal.project_ids[0] : null;
    const projectId = body.project_id === null || body.project_id === '' ? null : (body.project_id ?? inferredProject);
    if (projectId) requireProject(principal, projectId);
    const project = projectId && knowledgeRepository ? knowledgeRepository.getProject(projectId) : null;
    if (projectId && knowledgeRepository && !project) {
      throw new HttpError(400, 'project_not_found', `project does not exist: ${projectId}`);
    }
    const projectOwnerNode = projectId && knowledgeRepository
      ? knowledgeRepository.getProjectOwnerNodeId?.(projectId) ?? null
      : null;
    const projectAgent = projectId && projectAgentsRegistry ? projectAgentsRegistry.ensure(projectId) : null;
    const { task, idempotent_replay } = (taskCreationFacade || taskRepository).create({
      ...body,
      created_by: principal.subject_id,
      project_id: projectId,
      origin_node_id: nodeId,
      executor_node_id: projectId ? (projectOwnerNode || undefined) : nodeId,
      agent_id: body.agent_id ?? projectAgent?.agent_id ?? null,
    });
    if (!idempotent_replay) setImmediate(() => workerChannel?.tryDispatch());
    return { ok: true, task, idempotent_replay };
  });

  if (workflowAgent) {
    router.add('POST', '/api/v1/workflow/tasks/decompose', (req, res, body) => {
      const principal = requireAction(req, 'task:create');
      requireProject(principal, body.project_id);
      const tasks = workflowAgent.createTasks({ ...body, created_by: principal.subject_id, origin_node_id: nodeId });
      setImmediate(() => workerChannel?.tryDispatch());
      return { ok: true, tasks };
    });
  }

  router.add('GET', '/api/v1/tasks', (req) => {
    const principal = requireAction(req, 'task:read');
    const url = new URL(req.url, 'http://local');
    const requestedProject = url.searchParams.get('project_id');
    if (requestedProject) requireProject(principal, requestedProject);
    const allowedProjects = principal.project_ids?.includes('*') ? null : new Set(principal.project_ids || []);
    const listed = taskRepository.list({
      status: url.searchParams.get('status'),
      priority: url.searchParams.has('priority') ? Number(url.searchParams.get('priority')) : null,
      project_id: requestedProject,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100,
    });
    return {
      ok: true,
      tasks: allowedProjects ? listed.filter((task) => !task.project_id || allowedProjects.has(task.project_id)) : listed,
    };
  });

  router.add('GET', '/api/v1/tasks/:id', (req, res, body, params) => {
    const principal = requireAction(req, 'task:read');
    const task = requireTaskVisible(principal, taskRepository.get(params.id));
    return { ok: true, task };
  });

  router.add('GET', '/api/v1/tasks/:id/events', (req, res, body, params) => {
    const principal = requireAction(req, 'task:read');
    requireTaskVisible(principal, taskRepository.get(params.id));
    const url = new URL(req.url, 'http://local');
    const events = taskRepository.events(params.id, {
      afterSeq: url.searchParams.has('after_seq') ? Number(url.searchParams.get('after_seq')) : -1,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 500,
      type: url.searchParams.get('type'),
    });
    return { ok: true, events };
  });

  router.add('POST', '/api/v1/tasks/:id/cancel', (req, res, body, params) => {
    const principal = requireAction(req, 'task:cancel');
    const existing = requireTaskVisible(principal, taskRepository.get(params.id));
    const ownerWorkerId = existing.claim_worker_id;
    const task = taskRepository.cancel(existing.task_id, principal.subject_id);
    if (ownerWorkerId) {
      workerChannel?.sendToWorker?.(ownerWorkerId, frame('cancel', {
        task_id: task.task_id, reason: `cancelled by ${principal.subject_id}`,
      }));
    }
    return { ok: true, task };
  });

  if (interactionRepository) {
    router.add('GET', '/api/v1/interactions', (req) => {
      const principal = requireAction(req, 'task:read');
      const url = new URL(req.url, 'http://local');
      const taskId = url.searchParams.get('task_id');
      if (taskId) requireTaskVisible(principal, taskRepository.get(taskId));
      const interactions = interactionRepository.list({
        taskId,
        status: url.searchParams.get('status'),
      });
      return {
        ok: true,
        interactions: interactions.filter((interaction) => {
          const task = taskRepository.get(interaction.task_id);
          return task && projectAllowed(principal, task.project_id);
        }),
      };
    });

    router.add('GET', '/api/v1/interactions/:id', (req, res, body, params) => {
      const principal = requireAction(req, 'task:read');
      const interaction = interactionRepository.get(params.id);
      if (!interaction) throw new HttpError(404, 'interaction_not_found', 'interaction does not exist');
      requireTaskVisible(principal, taskRepository.get(interaction.task_id));
      return { ok: true, interaction };
    });

    router.add('POST', '/api/v1/interactions/:id/respond', (req, res, body, params) => {
      const principal = requireAction(req, 'interaction:respond');
      const interaction = interactionRepository.get(params.id);
      if (!interaction) throw new HttpError(404, 'interaction_not_found', 'interaction does not exist');
      requireTaskVisible(principal, taskRepository.get(interaction.task_id));
      if (['credential', 'file_select'].includes(interaction.kind)) {
        throw new HttpError(403, 'local_interaction_required', `${interaction.kind} must be resolved on the worker host`);
      }
      const result = workerChannel?.resolveInteraction(params.id, {
        interaction_id: params.id,
        response_id: body.response_id,
        answers: body.answers ?? {},
        answered_by: principal.subject_id,
      }) ?? { ok: false, error: 'worker_channel_unavailable' };
      if (!result.ok) throw new HttpError(404, result.error, result.error);
      return result;
    });

    router.add('POST', '/api/v1/interactions/:id/cancel', (req, res, body, params) => {
      const principal = requireAction(req, 'task:cancel');
      const interaction = interactionRepository.get(params.id);
      if (!interaction) throw new HttpError(404, 'interaction_not_found', 'interaction does not exist');
      requireTaskVisible(principal, taskRepository.get(interaction.task_id));
      const result = workerChannel?.cancelInteraction(params.id, principal.subject_id)
        ?? { ok: true, interaction: interactionRepository.cancel(params.id), delivered: false };
      return result;
    });
  }

  if (bridgeService) {
    const bridgeContext = (req, action, body) => {
      const { principal, bridgeId } = requireBridge(req, action);
      return {
        bridgeId,
        subjectId: principal.subject_id,
        tokenProjects: principal.project_ids || [],
        ...bridgeInput(body),
      };
    };

    router.add('POST', '/api/v1/bridge/register', (req, res, body) => {
      const context = bridgeContext(req, 'bridge:register', body);
      return sendBridge(res, bridgeService.register({
        ...context,
        metadata: body.metadata ?? {},
      }));
    });

    router.add('POST', '/api/v1/bridge/tasks/pull', (req, res, body) => {
      const context = bridgeContext(req, 'bridge:pull', body);
      return sendBridge(res, bridgeService.pull({
        ...context,
        payload: { state: body.state ?? null },
      }));
    });

    router.add('POST', '/api/v1/bridge/tasks/:id/heartbeat', (req, res, body, params) => {
      const context = bridgeContext(req, 'bridge:heartbeat', body);
      return sendBridge(res, bridgeService.heartbeat({
        ...context,
        taskId: params.id,
        claimToken: body.claim_token,
        payload: { state: body.state ?? null },
      }));
    });

    router.add('POST', '/api/v1/bridge/tasks/:id/events', (req, res, body, params) => {
      const context = bridgeContext(req, 'bridge:events', body);
      return sendBridge(res, bridgeService.progress({
        ...context,
        taskId: params.id,
        claimToken: body.claim_token,
        note: body.note ?? null,
        percent: body.percent ?? null,
        events: body.events ?? [],
      }));
    });

    router.add('POST', '/api/v1/bridge/tasks/:id/interactions', (req, res, body, params) => {
      const context = bridgeContext(req, 'bridge:events', body);
      return sendBridge(res, bridgeService.createInteraction({
        ...context,
        taskId: params.id,
        claimToken: body.claim_token,
        interaction: body.interaction,
      }));
    });

    router.add('POST', '/api/v1/bridge/tasks/:id/interactions/:interactionId/consumed', (req, res, body, params) => {
      const context = bridgeContext(req, 'bridge:events', body);
      return sendBridge(res, bridgeService.consumeInteraction({
        ...context,
        taskId: params.id,
        claimToken: body.claim_token,
        interactionId: params.interactionId,
      }));
    });

    router.add('POST', '/api/v1/bridge/tasks/:id/result', (req, res, body, params) => {
      const context = bridgeContext(req, 'bridge:result', body);
      return sendBridge(res, bridgeService.result({
        ...context,
        taskId: params.id,
        claimToken: body.claim_token,
        kind: body.kind,
        result: body.result ?? null,
        sessionRef: body.session_ref ?? null,
      }));
    });

    router.add('POST', '/api/v1/bridge/tasks/:id/release', (req, res, body, params) => {
      const context = bridgeContext(req, 'bridge:release', body);
      return sendBridge(res, bridgeService.release({
        ...context, taskId: params.id, claimToken: body.claim_token,
      }));
    });
  }

  // --- peer sync: handshake, pull, push, ack ---
  // Peer identity comes from the machine token subject, never from the body,
  // so a peer cannot push events under another node's identity.
  if (peerSyncService) {
    const peerIdentity = (req) => {
      const principal = requireAction(req, 'peer:sync');
      if (principal.auth_type !== 'machine' || principal.role !== 'peer') {
        throw new HttpError(403, 'peer_identity_required', 'a dedicated peer machine token is required');
      }
      const node = principal.subject_id.startsWith('machine:')
        ? principal.subject_id.slice('machine:'.length) : principal.subject_id;
      if (!node) throw new HttpError(403, 'peer_identity_required', 'peer token has no subject identity');
      return node;
    };

    router.add('POST', '/api/v1/peer/sync/handshake', (req, res, body) => {
      const node = peerIdentity(req);
      const peer = peerSyncService.registerPeer({
        node_id: node,
        endpoint: body.endpoint ?? null,
        display_name: body.display_name ?? null,
        protocol_version: body.protocol_version ?? undefined,
        public_key: body.public_key ?? undefined,
      });
      return {
        ok: true,
        node_id: nodeId,
        peer,
        public_key: peerSyncService.publicKeyBase64,
        protocol_version: peerSyncService.status().protocol_version,
        head_seq: peerSyncService.headSeq(),
      };
    });

    router.add('POST', '/api/v1/peer/sync/pull', (req, res, body) => {
      const node = peerIdentity(req);
      peerSyncService.requireActivePeer(node);
      const events = peerSyncService.eventsSince(body.since_seq ?? 0, { limit: body.limit });
      return {
        ok: true,
        events,
        next_seq: events.length ? events[events.length - 1].seq : peerSyncService.headSeq(),
      };
    });

    router.add('POST', '/api/v1/peer/sync/push', (req, res, body) => {
      const node = peerIdentity(req);
      const result = peerSyncService.ingest({ from_node: node, events: body.events });
      // The receiver echoes its inbound cursor so a push-only peer (one that
      // cannot be pulled from) still learns what was consumed and can prune.
      return { ok: true, inbound_cursor: peerSyncService.getCursor(node).inbound_cursor, ...result };
    });

    router.add('POST', '/api/v1/peer/sync/ack', (req, res, body) => {
      const node = peerIdentity(req);
      return { ok: true, cursor: peerSyncService.recordAck(node, body.seq) };
    });

    router.add('GET', '/api/v1/peer/sync/status', (req) => {
      requireAction(req, 'peer:sync');
      return { ok: true, ...peerSyncService.status() };
    });
  }

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
    router.add('GET', '/api/v1/workers/:id/config', (req, res, body, params) => {
      requireAdmin(req);
      const config = workersRegistry.serverConfig(params.id);
      if (!config) throw new HttpError(404, 'worker_not_found', 'worker does not exist');
      return { ok: true, config };
    });
    router.add('PUT', '/api/v1/workers/:id/config', (req, res, body, params) => {
      requireAdmin(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_config', 'config must be an object');
      const config = workersRegistry.saveServerConfig(params.id, {
        projects: Array.isArray(body.projects) ? body.projects : undefined,
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
        backends: Array.isArray(body.backends) ? body.backends : undefined,
        environment: body.environment === null ? null : (typeof body.environment === 'object' && !Array.isArray(body.environment) ? body.environment : undefined),
      });
      return { ok: true, config };
    });
    router.add('POST', '/api/v1/workers/:id/revoke', (req, res, body, params) => {
      requireAdmin(req);
      const revoked = workersRegistry.revoke(params.id, body?.reason ?? null);
      return { ok: true, revoked };
    });
    router.add('POST', '/api/v1/workers/:id/unrevoke', (req, res, body, params) => {
      requireAdmin(req);
      return { ok: true, revoked: workersRegistry.unrevoke(params.id) };
    });
    router.add('GET', '/api/v1/credentials', (req) => {
      requireAdmin(req);
      const url = new URL(req.url, 'http://local');
      const workerId = url.searchParams.get('worker_id') || null;
      return {
        ok: true,
        credentials: workersRegistry.listCredentials(workerId).map((entry) => ({
          credentialId: entry.credentialId, workerId: entry.workerId, name: entry.name, kind: entry.kind,
          reference: entry.reference, metadata: entry.metadata, updatedAt: entry.updatedAt,
        })),
      };
    });
    router.add('POST', '/api/v1/credentials', (req, res, body) => {
      requireAdmin(req);
      if (!body || typeof body.credentialId !== 'string' || !body.credentialId) throw new HttpError(400, 'credential_id_required', 'credentialId is required');
      let secretEncrypted = null;
      if (body.value != null && body.value !== '') {
        if (!credentialCipher) throw new HttpError(503, 'credential_cipher_unavailable', 'credential encryption is not configured');
        secretEncrypted = credentialCipher.encrypt(String(body.value));
      }
      const credential = workersRegistry.setCredential({
        credentialId: body.credentialId,
        workerId: body.worker_id ?? null,
        name: body.name ?? body.credentialId,
        kind: body.kind ?? 'static',
        secretEncrypted,
        reference: body.reference ?? null,
        metadata: body.metadata ?? {},
      });
      return { ok: true, credential: { credentialId: credential.credentialId, workerId: credential.workerId, name: credential.name, kind: credential.kind, reference: credential.reference, metadata: credential.metadata } };
    });
    router.add('DELETE', '/api/v1/credentials/:id', (req, res, body, params) => {
      requireAdmin(req);
      return { ok: true, deleted: workersRegistry.deleteCredential(params.id) };
    });
    // One-time device enrollment: the admin issues a code; devices consume it
    // with a machine identity and receive a worker machine token.
    router.add('GET', '/api/v1/enrollments', (req) => {
      requireAdmin(req);
      return { ok: true, enrollments: workersRegistry.listEnrollments() };
    });
    router.add('POST', '/api/v1/enrollments', (req, res, body) => {
      requireAdmin(req);
      const code = crypto.randomBytes(6).toString('base64url').toUpperCase();
      const enrollment = workersRegistry.createEnrollment({ code, workerId: body.worker_id ?? null, machine: body.machine ?? null });
      return { ok: true, code: enrollment.code, enrollment };
    });
    router.add('POST', '/api/v1/enrollments/consume', (req, res, body) => {
      if (typeof body.code !== 'string' || !body.code || typeof body.worker_id !== 'string' || !body.worker_id) {
        throw new HttpError(400, 'enrollment_code_required', 'code and worker_id are required');
      }
      const enrollment = workersRegistry.consumeEnrollment(body.code.toUpperCase(), { workerId: body.worker_id, machine: body.machine ?? null });
      if (!enrollment) throw new HttpError(403, 'invalid_enrollment', 'enrollment code is invalid or already consumed');
      // store the bare worker id; getMachineToken prefixes machine: when it
      // builds the principal, so a pre-prefixed id would double-prefix.
      const created = authRepository.createMachineToken({ subject_id: body.worker_id, role: 'worker', project_ids: ['*'] });
      return { ok: true, token: created.token, enrollment };
    });
    router.add('POST', '/api/v1/devices/register', (req, res, body) => {
      if (!body || typeof body.worker_id !== 'string' || !body.worker_id) throw new HttpError(400, 'worker_id_required', 'worker_id is required');
      const fingerprint = String(body.fingerprint ?? '');
      if (!fingerprint || !/^[A-Fa-f0-9]{16,64}$/.test(fingerprint)) throw new HttpError(400, 'fingerprint_invalid', 'fingerprint must be hex 16-64');
      const enrollment = workersRegistry.deviceRegister({ workerId: body.worker_id, machine: body.machine ?? null, fingerprint });
      return { ok: true, enrollment: publicEnrollment(enrollment) };
    });
    router.add('POST', '/api/v1/devices/poll', (req, res, body) => {
      if (!body || typeof body.worker_id !== 'string' || !body.worker_id) throw new HttpError(400, 'worker_id_required', 'worker_id is required');
      const result = workersRegistry.devicePoll(body.worker_id, String(body.fingerprint ?? ''));
      return { ok: true, ...result };
    });
    router.add('POST', '/api/v1/devices/:workerId/approve', (req, res, body, params) => {
      requireAdmin(req);
      const enrollment = workersRegistry.getEnrollment(params.workerId);
      if (!enrollment || enrollment.status !== 'pending') throw new HttpError(409, 'not_pending', 'device is not awaiting approval');
      const created = authRepository.createMachineToken({ subject_id: params.workerId, role: 'worker', project_ids: ['*'] });
      const updated = workersRegistry.deviceApprove(params.workerId, created.token);
      for (const workerId of workerChannel?.connectedWorkers?.() ?? []) workerChannel.pushConfig(workerId);
      return { ok: true, enrollment: publicEnrollment(updated) };
    });
    router.add('POST', '/api/v1/enrollments/revoke', (req, res, body) => {
      requireAdmin(req);
      return { ok: true, revoked: workersRegistry.revokeEnrollment(String(body.code ?? '').toUpperCase()) };
    });
    // Worker-broadcast workflow skills (the /workflow skill is a thin guide;
    // concrete skill content is distributed to every worker via config frames).
    router.add('GET', '/api/v1/skills', (req) => {
      requireAdmin(req);
      return { ok: true, skills: workersRegistry.listSkills().map((s) => ({ name: s.name, version: s.version, updatedAt: s.updatedAt })) };
    });
    router.add('GET', '/api/v1/skills/:name', (req, res, body, params) => {
      requireAdmin(req);
      const skill = workersRegistry.listSkills().find((s) => s.name === params.name);
      if (!skill) throw new HttpError(404, 'skill_not_found', 'skill does not exist');
      return { ok: true, skill };
    });
    router.add('PUT', '/api/v1/skills/:name', (req, res, body, params) => {
      requireAdmin(req);
      if (typeof body?.content !== 'string' || !body.content.trim()) throw new HttpError(400, 'content_required', 'content is required');
      const skill = workersRegistry.upsertSkill(params.name, body.content);
      for (const workerId of workerChannel?.connectedWorkers?.() ?? []) workerChannel.pushConfig(workerId);
      return { ok: true, skill };
    });
    router.add('DELETE', '/api/v1/skills/:name', (req, res, body, params) => {
      requireAdmin(req);
      const deleted = workersRegistry.deleteSkill(params.name);
      for (const workerId of workerChannel?.connectedWorkers?.() ?? []) workerChannel.pushConfig(workerId);
      return { ok: true, deleted };
    });
    router.add('POST', '/api/v1/skills/upload-folder', (req, res, body) => {
      requireAdmin(req);
      if (!body || !Array.isArray(body.files) || !body.files.length) throw new HttpError(400, 'files_required', 'files are required');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-skill-up-'));
      const BS = String.fromCharCode(92);
      try {
        let total = 0;
        for (const entry of body.files) {
          const rel = String(entry?.path ?? '').split(BS).join('/').split('/').filter(function(seg){ return seg && seg !== '.' && seg !== '..'; }).join('/');
          if (!rel || rel.length > 512) continue;
          const target = path.join(tmp, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const content = String(entry.content ?? '');
          total += Buffer.byteLength(content, 'utf8');
          if (total > 8 * 1024 * 1024) throw new HttpError(400, 'too_large', 'folder content exceeds 8 MiB');
          fs.writeFileSync(target, content);
        }
        // collect every SKILL.md in the tree: each directory with one becomes its own skill
        const skills = [];
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name === 'SKILL.md' && fs.statSync(full).size <= 512 * 1024) skills.push({ dir, file: full });
          }
        };
        walk(tmp);
        if (!skills.length) throw new HttpError(400, 'skill_doc_required', 'folder has no SKILL.md anywhere');
        let rootName = String(body.name ?? '').trim();
        if (!rootName) rootName = (body.files[0]?.path ?? '').split(BS).find(Boolean) || 'skill';
        const imported = [];
        for (const skill of skills) {
          const relDir = path.relative(tmp, skill.dir).split(BS).join('/');
          let name = relDir && !relDir.includes('/') ? relDir : (!relDir ? '' : path.basename(skill.dir));
          if (!name) name = relDir ? path.basename(skill.dir) : rootName;
          name = name.replace(/[^A-Za-z0-9._-]/g, '_');
          if (!name || imported.some((x) => x.name === name)) continue;
          const created = workersRegistry.upsertSkill(name, fs.readFileSync(skill.file, 'utf8'));
          imported.push({ name: created.name, version: created.version });
        }
        if (!imported.length) throw new HttpError(400, 'skill_doc_required', 'no unique skill entries found');
        for (const workerId of workerChannel?.connectedWorkers?.() ?? []) workerChannel.pushConfig(workerId);
        return { ok: true, imported };
      } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { } }
    });
        router.add('GET', '/api/v1/ai/suggestions', (req) => {
      requireAdmin(req);
      const url = new URL(req.url, 'http://local');
      return { ok: true, suggestions: suggestionsRepository.list({ status: url.searchParams.get('status') || null }) };
    });
    router.add('POST', '/api/v1/ai/checkup', async (req, res, body) => {
      requireAdmin(req);
      const result = await runCheckup();
      return { ok: true, ...result };
    });
    router.add('POST', '/api/v1/ai/suggestions/:id/approve', (req, res, body, params) => {
      requireAdmin(req);
      const suggestion = suggestionsRepository.get(params.id);
      if (!suggestion) throw new HttpError(404, 'suggestion_not_found', 'suggestion does not exist');
      if (suggestion.status !== 'pending') throw new HttpError(409, 'already_resolved', 'suggestion is not pending');
      const applied = applySuggestion(suggestion);
      const resolved = suggestionsRepository.resolve(params.id, 'approved', 'applied ' + JSON.stringify(applied));
      return { ok: true, suggestion: resolved };
    });
    router.add('POST', '/api/v1/ai/suggestions/:id/ignore', (req, res, body, params) => {
      requireAdmin(req);
      const resolved = suggestionsRepository.resolve(params.id, 'ignored');
      if (!resolved) throw new HttpError(404, 'suggestion_not_found', 'suggestion does not exist');
      return { ok: true, suggestion: resolved };
    });
    router.add('GET', '/api/v1/settings', (req) => {
      requireAdmin(req);
      const saved = settingsRepository.get('llm') ?? {};
      const keyCred = workersRegistry.listCredentials(null).find((c) => c.credentialId === 'server-llm-key');
      const llmRuntime = serverLlm?.status ?? { enabled: false };
      return { ok: true, settings: { llm: {
        backend: serverLlm?.cli ? 'dsh-cli' : 'direct',
        runtimeEnabled: llmRuntime.enabled,
        enabled: Boolean(saved.enabled ?? config.llm?.enabled ?? false),
        baseUrl: saved.baseUrl ?? config.llm?.baseUrl ?? null,
        model: saved.model ?? config.llm?.model ?? null,
        apiKeyConfigured: Boolean(keyCred?.secretEncrypted || config.llm?.apiKey),
      } } };
    });
    router.add('PUT', '/api/v1/settings', (req, res, body) => {
      requireAdmin(req);
      const llm = body?.llm ?? {};
      const saved = settingsRepository.get('llm') ?? {};
      settingsRepository.set('llm', {
        enabled: llm.enabled != null ? Boolean(llm.enabled) : saved.enabled,
        baseUrl: llm.baseUrl != null ? String(llm.baseUrl) : saved.baseUrl,
        model: llm.model != null ? String(llm.model) : saved.model,
      });
      if (typeof llm.apiKey === 'string' && llm.apiKey) {
        if (!credentialCipher) throw new HttpError(503, 'credential_cipher_unavailable', 'credential encryption is not configured');
        workersRegistry.setCredential({ credentialId: 'server-llm-key', workerId: null, name: 'Server LLM API Key', kind: 'server', secretEncrypted: credentialCipher.encrypt(llm.apiKey), metadata: {} });
      }
      Promise.resolve(serverLlm?.reload?.()).catch(()=>{}); // fire-and-forget
      return { ok: true };
    });
    router.add('POST', '/api/v1/skills/install-git', async (req, res, body) => {
      requireAdmin(req);
      const url = String(body?.url ?? '');
      if (!/^https:\/\/.+/i.test(url)) throw new HttpError(400, 'invalid_git_url', 'git url must be https://');
      const name = String(body?.name ?? '').trim() || url.replace(/\/+$/,'').split('/').pop().replace(/\.git$/i, '') || 'skill';
      const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_');
      const tmp = path.join(os.tmpdir(), `wf-skill-${crypto.randomUUID()}`);
      try {
        await new Promise((resolve, reject) => {
          execFile('git', ['clone', '--depth', '1', url, tmp], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, (error) => error ? reject(error) : resolve());
        });
        let content = '';
        for (const candidate of ['README.md', 'readme.md', 'SKILL.md']) {
          const file = path.join(tmp, candidate);
          if (fs.existsSync(file)) {
            const stat = fs.statSync(file);
            if (stat.isFile() && stat.size <= 64 * 1024) { content = fs.readFileSync(file, 'utf8'); break; }
          }
        }
        if (!content) throw new HttpError(400, 'readme_required', 'repository has no README.md/SKILL.md');
        const skill = workersRegistry.upsertSkill(safeName, content);
        for (const workerId of workerChannel?.connectedWorkers?.() ?? []) workerChannel.pushConfig(workerId);
        return { ok: true, skill: { name: skill.name, version: skill.version, updatedAt: skill.updatedAt } };
      } catch (error) {
        if (error.status) throw error;
        throw new HttpError(502, 'git_install_failed', `git install failed: ${error.message}`);
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });
  }

  // Project-agent views are read-only here; Worker registration is owned by
  // the authenticated WebSocket channel.
  if (projectAgentsRegistry) {
    router.add('GET', '/api/v1/project-agents', (req) => {
      const principal = requireAction(req, 'worker:read');
      const url = new URL(req.url, 'http://local');
      const projectId = url.searchParams.get('project_id') || null;
      if (projectId) requireProject(principal, projectId);
      const agents = projectAgentsRegistry.list({ projectId });
      return { ok: true, agents: principal.project_ids?.includes('*') ? agents : agents.filter((agent) => principal.project_ids?.includes(agent.project_id)) };
    });
    router.add('GET', '/api/v1/project-agents/:id', (req, res, body, params) => {
      const principal = requireAction(req, 'worker:read');
      const agent = projectAgentsRegistry.get(params.id);
      if (!agent) throw new HttpError(404, 'project_agent_not_found', 'project agent does not exist');
      requireProject(principal, agent.project_id);
      const tasks = taskRepository.list({ project_id: agent.project_id, limit: 500 });
      return { ok: true, agent, task_counts: tasks.reduce((counts, task) => ({ ...counts, [task.status]: (counts[task.status] || 0) + 1 }), {}) };
    });
    router.add('PATCH', '/api/v1/project-agents/:id', (req, res, body, params) => {
      const principal = requireAdmin(req);
      const agent = projectAgentsRegistry.get(params.id);
      if (!agent) throw new HttpError(404, 'project_agent_not_found', 'project agent does not exist');
      return { ok: true, agent: projectAgentsRegistry.update(params.id, body) };
    });
  }

  // --- live task control (inject reaches the connected owner worker) ---
  if (workerChannel) {
    router.add('POST', '/api/v1/tasks/:id/inject', (req, res, body, params) => {
      const principal = requireAdmin(req);
      const task = requireTaskVisible(principal, taskRepository.get(params.id));
      if (!['dispatched', 'running', 'awaiting_input'].includes(task.status)) {
        throw new HttpError(409, 'task_not_active', `task is ${task.status}`);
      }
      if (typeof body.content !== 'string' || !body.content.trim()) {
        throw new HttpError(400, 'content_required', 'inject content is required');
      }
      const delivered = workerChannel.sendToWorker?.(task.claim_worker_id, {
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
      const url = new URL(req.url, 'http://local');
      const matched = router.match(req.method, url.pathname);
      if (!matched) throw new HttpError(404, 'not_found', `no route: ${req.method} ${url.pathname}`);
      const bridgePath = url.pathname.startsWith('/api/v1/bridge/');
      const bodyLimit = url.pathname.endsWith('/events')
        ? MAX_BRIDGE_EVENTS_BODY_BYTES
        : bridgePath ? MAX_BRIDGE_BODY_BYTES : MAX_BODY_BYTES;
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, bodyLimit) : {};
      const result = await matched.handler(req, res, body, matched.params);
      if (result !== null && result !== undefined) send(res, 200, result);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      // Repository validation/state errors carry a code and map to 400;
      // anything else is a genuine server fault.
      const isRepositoryError = !(error instanceof HttpError) && typeof error.code === 'string' && error.code;
      const bridgeStatuses = {
        BRIDGE_REQUEST_CONFLICT: 409,
        CLAIM_MISMATCH: 409,
        TASK_ALREADY_STARTED: 409,
        TASK_NOT_ACTIVE: 409,
        TASK_NOT_AWAITING_INPUT: 409,
        INTERACTION_CONFLICT: 409,
        INTERACTION_RESPONSE_CONFLICT: 409,
        INTERACTION_OWNER_MISMATCH: 409,
        INTERACTION_NOT_ANSWERED: 409,
        INTERACTION_NOT_DELIVERED: 409,
        TASK_NOT_FOUND: 404,
        LEASE_EXPIRED: 410,
        PEER_UNKNOWN: 403,
        PEER_REVOKED: 403,
        PEER_PROTOCOL_UNSUPPORTED: 400,
        PEER_ACK_INVALID: 400,
      };
      const numericStatus = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : null;
      const status = error instanceof HttpError
        ? error.status
        : numericStatus ?? bridgeStatuses[error.code] ?? (error.code === 'REVISION_CONFLICT' ? 409 : isRepositoryError ? 400 : 500);
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
      const url = new URL(req.url, 'http://local');
      const includeLegacy = url.searchParams.get('include_legacy') === '1' && actionsAllow(principal.actions, '*');
      const candidates = knowledgeRepository.listProjects(queryOptions(req))
        .filter((item) => projectAllowed(principal, item.id))
        .filter((item) => isManagedProject(item, includeLegacy));
      const seen = new Set();
      const projects = candidates.filter((project) => {
        if (includeLegacy) return true;
        const key = projectCatalogKey(project);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      projects.forEach((project) => projectAgentsRegistry?.ensure(project.id));
      return { ok: true, projects };
    });

    router.add('POST', '/api/v1/workflow/projects/resolve', (req, res, body) => {
      const create = body.create !== false;
      const principal = requireAction(req, create ? 'knowledge:write' : 'knowledge:read');
      const existing = knowledgeRepository.resolveProject({ ...body, create: false });
      if (existing) {
        requireProject(principal, existing.id);
        projectAgentsRegistry?.ensure(existing.id);
        return { ok: true, project: existing };
      }
      if (!create) return { ok: true, project: null };
      if (!principal.project_ids?.includes('*') && !principal.project_ids?.includes(body.projectId)) {
        throw new HttpError(403, 'project_forbidden', 'creating a project requires wildcard scope or an allowed explicit projectId');
      }
      const project = knowledgeRepository.resolveProject(body);
      projectAgentsRegistry?.ensure(project.id);
      return { ok: true, project };
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
