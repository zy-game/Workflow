// channel.js - authenticated WebSocket control channel for workers.
// Mounts on the public HTTPS server at /worker. Machines authenticate with a
// Bearer worker-scope token at upgrade time; every task mutation frame must
// carry the claim token issued at dispatch.
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, frame, isWorkerFrame, parseFrame } from '@workflow-core/shared';
import { actionsAllow } from '../http/server.js';
import { selectorMatches } from '../tasks/repository.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const WORKER_PATH = '/worker';

export function createWorkerChannel({
  authRepository, taskRepository, workersRegistry, modelRegistry, dshSync = null, managementAi = null,
  feishuService = null, approvalsRegistry = null, log = () => {},
} = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map(); // worker_id -> { ws, worker, principal }

  function sendTo(workerId, frameValue) {
    const session = sessions.get(workerId);
    if (!session || session.ws.readyState !== session.ws.OPEN) return false;
    session.ws.send(JSON.stringify(frameValue));
    return true;
  }

  function modelsFrame() {
    return frame('models', { models: modelRegistry.pushList(), revision: modelRegistry.revision });
  }

  function broadcastModels() {
    if (!modelRegistry) return;
    for (const [workerId] of sessions) sendTo(workerId, modelsFrame());
    log(`[ws] models revision ${modelRegistry.revision} pushed to ${sessions.size} worker(s)`);
  }

  async function syncDshModel() {
    if (!dshSync || !modelRegistry) return;
    try {
      await dshSync.syncTopModel(modelRegistry);
    } catch (error) {
      log(`[ws] central DSH model sync failed: ${error.message}`);
    }
  }

  // --- dispatcher -------------------------------------------------------
  function activeTaskCount(workerId) {
    return taskRepository.activeForWorker(workerId).length;
  }

  function resumeActiveTasks(session) {
    let resumed = 0;
    for (const task of taskRepository.activeForWorker(session.worker.worker_id)) {
      if (!sendTo(session.worker.worker_id, frame('dispatch', { task, resumed: true }))) break;
      resumed += 1;
    }
    return resumed;
  }

  function dispatchToWorker(session) {
    const { worker } = session;
    let dispatched = 0;
    while (activeTaskCount(worker.worker_id) < worker.max_concurrency) {
      const task = taskRepository.claim({ worker_id: worker.worker_id, selector: worker.selector });
      if (!task) break;
      const delivered = sendTo(worker.worker_id, frame('dispatch', { task }));
      if (!delivered) {
        // Socket died mid-dispatch: release the claim back to the queue.
        taskRepository.db.prepare(
          "UPDATE tasks SET status = 'queued', claim_token = NULL, claim_worker_id = NULL, lease_deadline = NULL, updated_at = ? WHERE task_id = ?",
        ).run(new Date().toISOString(), task.task_id);
        break;
      }
      dispatched += 1;
    }
    return dispatched;
  }

  function tryDispatch() {
    let total = 0;
    for (const session of sessions.values()) {
      if (!session.worker?.fresh) continue;
      total += dispatchToWorker(session);
    }
    return total;
  }

  // --- connection handling ----------------------------------------------
  function handleUpgrade(server) {
    server.on('upgrade', (request, socket, head) => {
      let pathname = '/';
      try { pathname = new URL(request.url, 'http://local').pathname; } catch { /* keep default */ }
      if (pathname !== WORKER_PATH) return; // other upgrade paths handled elsewhere
      let principal = null;
      try {
        const header = request.headers.authorization;
        const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        const machine = token ? authRepository.getMachineToken(token) : null;
        if (!machine) throw new Error('invalid token');
        if (!actionsAllow(machine.principal.actions, 'worker:register')) throw new Error('worker scope required');
        principal = machine.principal;
      } catch (error) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        // One session object per connection carries registration state
        // across frames; task frames validate ownership against it.
        const session = { ws, principal, worker: null };
        ws.on('message', (data) => {
          let parsed;
          try { parsed = parseFrame(JSON.parse(data.toString())); } catch { return; }
          if (!parsed || !isWorkerFrame(parsed)) {
            ws.send(JSON.stringify(frame('error', { error: 'invalid frame' })));
            return;
          }
          handleMessage(session, parsed).catch((error) => {
            log(`[ws] frame ${parsed.type} failed: ${error.message}`);
            ws.send(JSON.stringify(frame('error', { error: error.message, in_reply_to: parsed.id })));
          });
        });
        ws.on('close', () => {
          for (const [workerId, registered] of sessions) {
            if (registered.ws === ws) {
              sessions.delete(workerId);
              try { workersRegistry?.markDisconnected(workerId); } catch { /* database may already be closing */ }
              log(`[ws] worker ${workerId} disconnected`);
            }
          }
        });
        ws.on('error', () => { /* close handler performs cleanup */ });
      });
    });
  }

  // Server-side liveness pings; dead sockets drop and free the worker.
  const pingTimer = setInterval(() => {
    for (const session of sessions.values()) {
      if (session.ws.readyState === session.ws.OPEN) session.ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  pingTimer.unref();

  async function handleMessage(session, { type, payload }) {
    switch (type) {
      case 'register': {
        const worker = workersRegistry.register({
          worker_id: String(payload.worker_id || ''),
          subject_id: session.principal.subject_id,
          machine: payload.machine ?? null,
          capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : [],
          selector: payload.selector && typeof payload.selector === 'object' ? payload.selector : {},
          max_concurrency: payload.max_concurrency ?? 1,
          version: payload.version ?? null,
        });
        session.worker = worker;
        const previous = sessions.get(worker.worker_id);
        if (previous && previous.ws !== session.ws) previous.ws.close();
        sessions.set(worker.worker_id, session);
        session.ws.send(JSON.stringify(frame('config', {
          protocol_version: PROTOCOL_VERSION,
          heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
          worker,
        })));
        if (modelRegistry) session.ws.send(JSON.stringify(modelsFrame()));
        const resumed = resumeActiveTasks(session);
        log(`[ws] worker ${worker.worker_id} registered (capabilities: ${worker.capabilities.join(',') || 'none'}, resumed: ${resumed})`);
        tryDispatch();
        break;
      }
      case 'heartbeat': {
        if (!session.worker || !workersRegistry.heartbeat(session.worker.worker_id)) {
          throw new Error('not registered');
        }
        session.ws.send(JSON.stringify(frame('ping', { server_time: new Date().toISOString() })));
        break;
      }
      case 'progress': {
        requireOwnership(taskRepository, session, payload);
        const task = taskRepository.progress(payload.task_id, String(payload.claim_token || ''), {
          note: payload.note ?? null, percent: payload.percent ?? null,
          events: Array.isArray(payload.events) ? payload.events : [],
        });
        return task;
      }
      case 'session_event': {
        requireOwnership(taskRepository, session, payload, { requireClaim: false });
        return taskRepository.appendSessionEvent(payload.task_id, payload.event ?? {}, session.worker?.worker_id ?? null);
      }
      case 'task_done': {
        requireOwnership(taskRepository, session, payload);
        const task = taskRepository.done(payload.task_id, String(payload.claim_token || ''), {
          kind: payload.kind ?? 'done', result: payload.result ?? null,
        });
        setImmediate(() => tryDispatch()); // freed capacity
        // Knowledge review runs off the wire; failures never affect the task.
        if (managementAi && ['done', 'blocked'].includes(task.status)) {
          setImmediate(() => {
            managementAi.reviewCompletedTask(task).catch((error) => log(`[ai] review failed for ${task.task_id}: ${error.message}`));
          });
        }
        return task;
      }
      case 'models_ack': {
        workersRegistry.recordModelsAck(session.worker.worker_id, payload.revision ?? 0);
        return { acknowledged: true };
      }
      case 'capabilities_update': {
        const worker = workersRegistry.register({
          ...session.worker,
          worker_id: session.worker.worker_id,
          capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : session.worker.capabilities,
          selector: payload.selector ?? session.worker.selector,
          max_concurrency: payload.max_concurrency ?? session.worker.max_concurrency,
        });
        session.worker = worker;
        tryDispatch();
        return worker;
      }
      case 'approval_request': {
        requireOwnership(taskRepository, session, payload, { requireClaim: false });
        // Feishu renders the ask into approve/deny card buttons; either way
        // the registry row is what every resolution surface acts on.
        if (feishuService) {
          return feishuService.handleApprovalRequest(payload);
        }
        const record = approvalsRegistry.create({
          taskId: payload.task_id,
          tool: payload.tool ?? null,
          risk: payload.risk ?? null,
          reason: payload.reason ?? null,
          dshApprovalId: payload.dsh_approval_id ?? null,
          dshRpcId: payload.dsh_rpc_id ?? null,
          dshSessionId: payload.dsh_session_id ?? null,
        });
        taskRepository.appendSessionEvent(payload.task_id, {
          kind: 'approval_request', approval_id: record.approval_id,
          tool: record.tool, risk: record.risk, reason: record.reason,
        }, session.worker?.worker_id ?? null);
        return { approval_id: record.approval_id };
      }
      case 'error': {
        log(`[ws] worker ${session.worker?.worker_id ?? 'unknown'} error: ${payload.error ?? 'unknown'}`);
        return { logged: true };
      }
      default:
        throw new Error(`unhandled frame: ${type}`);
    }
    return null;
  }

  function requireOwnership(tasks, session, payload, { requireClaim = true } = {}) {
    if (!session.worker) throw new Error('not registered');
    const task = tasks.get(payload.task_id);
    if (!task) {
      const error = new Error('task does not exist');
      error.code = 'TASK_NOT_FOUND';
      throw error;
    }
    if (task.claim_worker_id !== session.worker.worker_id) throw new Error('task not claimed by this worker');
    if (requireClaim && !payload.claim_token) throw new Error('claim_token required');
  }

  // Single resolution path shared by the Feishu card, Feishu replies, and the
  // admin console: persist the decision, audit it on the task, and hand the
  // DSH identifiers back to the owning worker.
  function resolveApproval(approvalId, approved, operator = 'admin') {
    const record = approvalsRegistry.resolve(approvalId, approved, operator);
    if (!record) return { ok: false, error: 'approval_not_found' };
    taskRepository.appendSessionEvent(record.task_id, {
      kind: 'approval_resolved', approval_id: approvalId, approved, by: operator,
    }, operator);
    const task = taskRepository.get(record.task_id);
    if (task?.claim_worker_id) {
      sendTo(task.claim_worker_id, frame('approval_result', {
        task_id: record.task_id, approval_id: approvalId, approved, by: operator,
        dsh_approval_id: record.dsh_approval_id, dsh_rpc_id: record.dsh_rpc_id,
        dsh_session_id: record.dsh_session_id,
      }));
    }
    if (feishuService) {
      Promise.resolve(feishuService.refreshCardForTask(record.task_id)).catch(() => {});
    }
    return { ok: true, approved };
  }

  return {
    wss,
    handleUpgrade,
    tryDispatch,
    broadcastModels,
    syncDshModel,
    sendToWorker: sendTo,
    resolveApproval,
    pendingApprovals: (options = {}) => approvalsRegistry.pending(options),
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
