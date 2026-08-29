// channel.js - authenticated WebSocket control channel for workers.
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, frame, isWorkerFrame, parseFrame } from '@workflow-core/shared';
import { actionsAllow } from '../http/server.js';
import { selectorMatches } from '../tasks/repository.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const WORKER_PATH = '/worker';
const OPEN = 1;

function workerIdForPrincipal(principal) {
  const subject = String(principal?.subject_id || '');
  return subject.startsWith('machine:') ? subject.slice('machine:'.length) : subject;
}

function scopedProjects(principal, requested) {
  const tokenProjects = Array.isArray(principal.project_ids) ? principal.project_ids.map(String) : [];
  const projects = Array.isArray(requested) ? requested : [];
  const ids = [...new Set(projects.map((project) => typeof project === 'string' ? project : project?.project_id).filter(Boolean))];
  if (tokenProjects.includes('*')) return ids;
  for (const projectId of ids) {
    if (!tokenProjects.includes(projectId)) throw new Error(`project not permitted by worker token: ${projectId}`);
  }
  return ids;
}

export function createWorkerChannel({
  authRepository, taskRepository, interactionRepository, workersRegistry,
  feishuService = null, credentialCipher = null, nodeId = null, log = () => {},
} = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map();

  function sendTo(workerId, frameValue) {
    const session = sessions.get(workerId);
    if (!session || session.ws.readyState !== OPEN) return false;
    try {
      session.ws.send(JSON.stringify(frameValue));
      return true;
    } catch {
      return false;
    }
  }

  function buildConfigFrame(workerId) {
    const serverConfig = workersRegistry.serverConfig(workerId);
    const revoked = workersRegistry.isRevoked(workerId);
    let credentials = [];
    try {
      credentials = workersRegistry.listCredentials(workerId).map((entry) => ({
        credentialId: entry.credentialId,
        name: entry.name,
        kind: entry.kind,
        reference: entry.reference,
        metadata: entry.metadata,
        value: entry.secretEncrypted && credentialCipher ? credentialCipher.decrypt(entry.secretEncrypted) : null,
      }));
    } catch (error) {
      log(`[ws] credential delivery failed for ${workerId}: ${error.message}`);
    }
    const skills = workersRegistry.listSkills().map((skill) => ({ name: skill.name, version: skill.version, content: skill.content }));
    return frame('config', {
      protocol_version: PROTOCOL_VERSION,
      heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
      worker: workersRegistry.get(workerId),
      server_config: serverConfig ?? null,
      credentials,
      skills,
      revoked,
    });
  }

  function pushConfig(workerId) {
    return sendTo(workerId, buildConfigFrame(workerId));
  }

  function activeTaskCount(workerId) {
    return taskRepository.activeForWorker(workerId, undefined, nodeId).length;
  }

  function deliverInteraction(interaction) {
    if (!interaction?.worker_id || !interaction.response) return false;
    const task = taskRepository.get(interaction.task_id);
    if (!task || task.claim_worker_id !== interaction.worker_id || !task.claim_token) return false;
    const delivered = sendTo(interaction.worker_id, frame('interaction_response', {
      task_id: task.task_id,
      claim_token: task.claim_token,
      interaction_id: interaction.interaction_id,
      response: interaction.response,
    }));
    if (!delivered) return false;
    interactionRepository.markDelivered(interaction.interaction_id);
    return true;
  }

  function resumeSession(workerId) {
    let resumed = 0;
    for (const task of taskRepository.activeForWorker(workerId, undefined, nodeId)) {
      if (!sendTo(workerId, frame('dispatch', { task, resumed: true }))) break;
      resumed += 1;
    }
    for (const interaction of interactionRepository.pendingDelivery(workerId)) deliverInteraction(interaction);
    return resumed;
  }

  function dispatchToWorker(workerId) {
    const session = sessions.get(workerId);
    const worker = workersRegistry.get(workerId);
    if (!session || session.ws.readyState !== OPEN || !worker?.connected || !worker.fresh || worker.state !== 'running') return 0;
    let dispatched = 0;
    while (activeTaskCount(workerId) < worker.max_concurrency) {
      const task = taskRepository.claim({
        worker_id: workerId,
        node_id: nodeId,
        selector: worker.selector,
        project_ids: worker.projects,
        capabilities: worker.capabilities,
        backends: worker.backends,
      });
      if (!task) break;
      if (!sendTo(workerId, frame('dispatch', { task }))) {
        taskRepository.releaseUndeliveredClaim(task.task_id, task.claim_token);
        break;
      }
      dispatched += 1;
    }
    return dispatched;
  }

  function tryDispatch() {
    let total = 0;
    for (const workerId of sessions.keys()) total += dispatchToWorker(workerId);
    return total;
  }

  function handleUpgrade(server) {
    server.on('upgrade', (request, socket, head) => {
      let pathname = '/';
      try { pathname = new URL(request.url, 'http://local').pathname; } catch { /* keep default */ }
      if (pathname !== WORKER_PATH) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      let principal;
      try {
        const header = request.headers.authorization;
        const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        const machine = token ? authRepository.getMachineToken(token) : null;
        if (!machine) throw new Error('invalid token');
        if (!actionsAllow(machine.principal.actions, 'worker:register')) throw new Error('worker scope required');
        principal = machine.principal;
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const session = { ws, principal, workerId: null, queue: Promise.resolve() };
        ws.on('message', (data) => {
          let parsed;
          try { parsed = parseFrame(JSON.parse(data.toString())); } catch { parsed = null; }
          if (!parsed || !isWorkerFrame(parsed)) {
            ws.send(JSON.stringify(frame('error', { error: 'invalid frame' })));
            return;
          }
          session.queue = session.queue
            .catch(() => {})
            .then(() => handleMessage(session, parsed))
            .then((result) => {
              if (parsed.type !== 'register') {
                workersRegistry.recordInboundFrame(session.workerId, parsed.id);
                if (ws.readyState === OPEN) ws.send(JSON.stringify(frame('ack', { frame_id: parsed.id, accepted: true })));
              }
              return result;
            })
            .catch((error) => {
              log(`[ws] frame ${parsed.type} failed: ${error.message}`);
              if (ws.readyState === OPEN) {
                ws.send(JSON.stringify(frame('error', { error: error.message, code: error.code ?? null, in_reply_to: parsed.id })));
                if (parsed.type !== 'register') {
                  try {
                    workersRegistry.recordInboundFrame(session.workerId, parsed.id);
                    ws.send(JSON.stringify(frame('ack', {
                      frame_id: parsed.id,
                      accepted: false,
                      error: error.code ?? error.message,
                    })));
                  } catch { /* connection or database may be closing */ }
                }
              }
            });
        });
        ws.on('close', () => {
          if (session.workerId && sessions.get(session.workerId)?.ws === ws) {
            sessions.delete(session.workerId);
            try { workersRegistry.markDisconnected(session.workerId); } catch { /* database may be closing */ }
            log(`[ws] worker ${session.workerId} disconnected`);
          }
        });
        ws.on('error', () => { /* close performs cleanup */ });
      });
    });
  }

  const pingTimer = setInterval(() => {
    for (const session of sessions.values()) {
      if (session.ws.readyState === OPEN) session.ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  pingTimer.unref();

  async function handleMessage(session, { type, id, payload }) {
    if (type !== 'register' && !session.workerId) throw new Error('not registered');
    if (type !== 'register') {
      if (workersRegistry.hasInboundFrame(session.workerId, id)) {
        if (session.ws.readyState === OPEN) session.ws.send(JSON.stringify(frame('ack', { frame_id: id, duplicate: true, accepted: true })));
        return { duplicate: true };
      }
    }
    let result;
    switch (type) {
      case 'register': {
        const authenticatedId = workerIdForPrincipal(session.principal);
        const requestedId = String(payload.worker_id || authenticatedId);
        if (!authenticatedId || requestedId !== authenticatedId) throw new Error('worker_id does not match token subject');
        const worker = workersRegistry.register({
          worker_id: authenticatedId,
          subject_id: session.principal.subject_id,
          machine: payload.machine ?? null,
          capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : [],
          selector: payload.selector && typeof payload.selector === 'object' ? payload.selector : {},
          projects: scopedProjects(session.principal, payload.projects),
          backends: Array.isArray(payload.backends) ? payload.backends : [],
          state: payload.state ?? 'running',
          config_revision: payload.config_revision ?? 0,
          max_concurrency: payload.max_concurrency ?? 1,
          version: payload.version ?? null,
        });
        session.workerId = authenticatedId;
        const previous = sessions.get(authenticatedId);
        if (previous && previous.ws !== session.ws) previous.ws.close();
        sessions.set(authenticatedId, session);
        session.ws.send(JSON.stringify(buildConfigFrame(authenticatedId)));
        const resumed = resumeSession(authenticatedId);
        log(`[ws] worker ${authenticatedId} registered (resumed: ${resumed})`);
        tryDispatch();
        return worker;
      }
      case 'heartbeat': {
        if (!workersRegistry.heartbeat(session.workerId, { state: payload.state ?? null })) throw new Error('not registered');
        for (const task of taskRepository.activeForWorker(session.workerId, undefined, nodeId)) {
          try { taskRepository.renew(task.task_id, task.claim_token); } catch { /* claim may have expired */ }
        }
        session.ws.send(JSON.stringify(frame('ping', { server_time: new Date().toISOString() })));
        if (payload.state === 'running') tryDispatch();
        return { acknowledged: true };
      }
      case 'status': {
        if (!workersRegistry.heartbeat(session.workerId, { state: payload.state ?? 'running' })) throw new Error('not registered');
        if ((payload.state ?? 'running') === 'running') tryDispatch();
        return workersRegistry.get(session.workerId);
      }
      case 'progress': {
        requireOwnership(session, payload);
        return taskRepository.progress(payload.task_id, payload.claim_token, {
          note: payload.note ?? null,
          percent: payload.percent ?? null,
          events: Array.isArray(payload.events) ? payload.events : [],
        });
      }
      case 'session_event': {
        requireOwnership(session, payload);
        return taskRepository.appendSessionEvent(payload.task_id, payload.event ?? {}, session.workerId);
      }
      case 'interaction_required': {
        const task = requireOwnership(session, payload);
        const interaction = interactionRepository.create({
          ...payload,
          worker_id: session.workerId,
          backend_kind: task.backend_kind,
          session_ref: payload.session_ref ?? task.session_ref,
        });
        if (task.status !== 'awaiting_input') {
          taskRepository.enterAwaitingInput(task.task_id, task.claim_token, interaction.interaction_id);
        }
        if (['question', 'approval'].includes(interaction.kind)) {
          Promise.resolve(feishuService?.handleInteractionRequired?.(interaction)).catch((error) => {
            log(`[feishu] interaction ${interaction.interaction_id} failed: ${error.message}`);
          });
        }
        return interaction;
      }
      case 'interaction_resolved': {
        const task = requireOwnership(session, payload);
        const interaction = interactionRepository.markConsumed(payload.interaction_id, session.workerId);
        if (task.status === 'awaiting_input') {
          taskRepository.resumeAfterInput(task.task_id, task.claim_token, interaction.interaction_id, session.workerId);
        }
        taskRepository.appendEvent(payload.task_id, 'interaction_consumed', {
          interaction_id: payload.interaction_id,
        }, session.workerId);
        return interaction;
      }
      case 'task_done': {
        requireOwnership(session, payload);
        const task = taskRepository.done(payload.task_id, payload.claim_token, {
          kind: payload.kind ?? 'done', result: payload.result ?? null,
          session_ref: payload.session_ref ?? null,
        });
        setImmediate(tryDispatch);
        return task;
      }
      case 'task_failed': {
        requireOwnership(session, payload);
        const task = taskRepository.done(payload.task_id, payload.claim_token, {
          kind: 'failed', result: payload.result ?? { error: payload.error ?? 'worker failed' },
          session_ref: payload.session_ref ?? null,
        });
        setImmediate(tryDispatch);
        return task;
      }
      case 'error':
        log(`[ws] worker ${session.workerId} error: ${payload.error ?? 'unknown'}`);
        return { logged: true };
      default:
        throw new Error(`unhandled frame: ${type}`);
    }
  }

  function requireOwnership(session, payload) {
    const task = taskRepository.get(payload.task_id);
    if (!task) {
      const error = new Error('task does not exist');
      error.code = 'TASK_NOT_FOUND';
      throw error;
    }
    if (task.claim_worker_id !== session.workerId) throw new Error('task not claimed by this worker');
    if (!payload.claim_token || payload.claim_token !== task.claim_token) throw new Error('claim token mismatch');
    return task;
  }

  function resolveInteraction(interactionId, response) {
    const interaction = interactionRepository.answer(interactionId, response);
    if (!interaction) return { ok: false, error: 'interaction_not_found' };
    const delivered = deliverInteraction(interaction);
    return { ok: true, interaction: interactionRepository.get(interactionId), delivered };
  }

  function cancelInteraction(interactionId, actor = 'admin') {
    const interaction = interactionRepository.cancel(interactionId);
    if (!interaction) return { ok: false, error: 'interaction_not_found' };
    const task = taskRepository.get(interaction.task_id);
    const delivered = task?.claim_worker_id
      ? sendTo(task.claim_worker_id, frame('interaction_cancel', {
        task_id: task.task_id,
        interaction_id: interaction.interaction_id,
        by: actor,
      }))
      : false;
    taskRepository.appendEvent(interaction.task_id, 'interaction_cancelled', {
      interaction_id: interaction.interaction_id,
    }, actor);
    return { ok: true, interaction, delivered };
  }

  return {
    wss,
    handleUpgrade,
    tryDispatch,
    sendToWorker: sendTo,
    pushConfig,
    resolveInteraction,
    cancelInteraction,
    connectedWorkers: () => [...sessions.keys()],
    connectedCount: () => sessions.size,
    stop: () => {
      clearInterval(pingTimer);
      for (const client of wss.clients) client.terminate();
      sessions.clear();
      wss.close();
    },
  };
}

export { selectorMatches };
