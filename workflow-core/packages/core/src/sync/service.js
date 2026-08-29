// service.js - peer synchronization over core.db: a registry of known peer
// nodes, a monotonic outbox of locally-originated decisions, an idempotent
// inbox for remote events, and per-peer cursors. Publishing hooks into the
// task repository's event observer so a domain mutation and its outbox event
// commit in the same transaction; ingest applies remote events through the
// task repository's projection writes so replayed or late events can never
// resurrect a finished task or rewrite frozen routing.
import crypto from 'node:crypto';
import { transaction } from '../db/base.js';
import { NODE_ID_PATTERN } from '../node-identity.js';

export const PEER_SYNC_PROTOCOL_VERSION = 1;

// Task events that carry a decision worth projecting onto peer nodes.
// Claim/lease/progress/session events are execution-local to the worker
// connection that holds the claim and are deliberately not synchronized.
const SYNCED_TASK_EVENTS = new Set(['created', 'done', 'cancelled', 'dead_letter', 'awaiting_input']);

export function isPeerProtocolSupported(version) {
  return Number(version) === PEER_SYNC_PROTOCOL_VERSION;
}

function wireEventFromRow(row) {
  return {
    event_id: row.event_id,
    seq: Number(row.seq),
    origin_node_id: row.origin_node_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    operation: row.operation,
    payload: JSON.parse(row.payload_json || '{}'),
    created_at: row.created_at,
  };
}

function taskSnapshot(task) {
  return {
    task_id: task.task_id,
    type: task.type,
    title: task.title,
    brief: task.brief,
    priority: task.priority,
    created_by: task.created_by,
    project_id: task.project_id,
    origin_node_id: task.origin_node_id,
    executor_node_id: task.executor_node_id,
    execution_policy_snapshot: task.execution_policy_snapshot,
    agent_id: task.agent_id,
    requested_backend_kind: task.requested_backend_kind,
    required_capabilities: task.required_capabilities,
    worker_selector: task.worker_selector,
    dependencies: task.dependencies,
    idempotency_key: task.idempotency_key,
    max_attempts: task.max_attempts,
    created_at: task.created_at,
  };
}

function eventOutcome(event) {
  return {
    status: event.payload?.status ?? null,
    result_kind: event.payload?.result_kind ?? null,
  };
}

export class PeerSyncService {
  // Shares the CoreDatabase handle with the task repository so outbox writes
  // join the domain transaction that produced them.
  constructor({ coreDb, nodeId, taskRepository, now = () => new Date().toISOString() } = {}) {
    if (!coreDb?.db) throw new TypeError('coreDb is required');
    if (!NODE_ID_PATTERN.test(String(nodeId ?? ''))) throw new TypeError('a valid nodeId is required');
    if (!taskRepository) throw new TypeError('taskRepository is required');
    this.db = coreDb.db;
    this.nodeId = String(nodeId);
    this.tasks = taskRepository;
    this.now = now;
    this.unsubscribe = taskRepository.onEvent((event) => this.#onTaskEvent(event));
  }

  close() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // --- publishing ---

  #onTaskEvent(event) {
    if (!SYNCED_TASK_EVENTS.has(event.type)) return;
    let task = this.tasks.get(event.task_id);
    if (!task) return;
    // Creation decisions only originate here; execution updates are also
    // published by the executor node. Projections written by ingest are
    // excluded because ingest applies them as terminal-absorbing updates
    // that never re-enter this observer (loop prevention).
    const isOrigin = task.origin_node_id === this.nodeId;
    const isExecutor = task.executor_node_id === this.nodeId;
    if (event.type === 'created') {
      if (!isOrigin) return;
      this.#publish({
        entity_type: 'task',
        entity_id: task.task_id,
        operation: 'create',
        payload: taskSnapshot(task),
      });
      return;
    }
    if (!isOrigin && !isExecutor) return;
    const status = event.type === 'awaiting_input'
      ? 'awaiting_input'
      : event.type === 'cancelled' ? 'cancelled'
        : event.type === 'dead_letter' ? 'failed'
          : task.status;
    this.#publish({
      entity_type: 'task',
      entity_id: task.task_id,
      operation: 'update',
      payload: {
        status,
        result_kind: task.result_kind,
        result: task.result,
        session_ref: task.session_ref,
        finished_at: task.finished_at,
      },
    });
  }

  #publish({ entity_type, entity_id, operation, payload }) {
    this.db.prepare(`
      INSERT INTO peer_sync_outbox (event_id, origin_node_id, entity_type, entity_id, operation, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `pse-${crypto.randomUUID()}`, this.nodeId, entity_type, entity_id,
      operation, JSON.stringify(payload ?? {}), this.now(),
    );
  }

  headSeq() {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM peer_sync_outbox').get().head);
  }

  eventsSince(sinceSeq, { limit = 500 } = {}) {
    const cursor = Number(sinceSeq ?? 0);
    const bounded = Math.min(2000, Math.max(1, Number(limit) || 500));
    return this.db.prepare(
      'SELECT * FROM peer_sync_outbox WHERE seq > ? ORDER BY seq ASC LIMIT ?',
    ).all(cursor, bounded).map(wireEventFromRow);
  }

  // --- peer registry ---

  registerPeer({ node_id, endpoint = null, display_name = null, protocol_version = PEER_SYNC_PROTOCOL_VERSION } = {}) {
    const peerId = String(node_id ?? '').trim();
    if (!NODE_ID_PATTERN.test(peerId)) throw new TypeError('node_id must match ^[a-z][a-z0-9._-]{2,63}$');
    if (!isPeerProtocolSupported(protocol_version)) {
      const error = new Error(`unsupported peer protocol version: ${protocol_version}`);
      error.code = 'PEER_PROTOCOL_UNSUPPORTED';
      throw error;
    }
    const timestamp = this.now();
    this.db.prepare(`
      INSERT INTO peer_nodes (node_id, display_name, endpoint_url, protocol_version, status, created_at, updated_at, last_seen_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, display_name),
        endpoint_url = COALESCE(excluded.endpoint_url, endpoint_url),
        protocol_version = excluded.protocol_version,
        status = 'active',
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `).run(peerId, display_name, endpoint, Number(protocol_version), timestamp, timestamp, timestamp);
    return this.getPeer(peerId);
  }

  getPeer(nodeId) {
    const row = this.db.prepare('SELECT * FROM peer_nodes WHERE node_id = ?').get(String(nodeId));
    if (!row) return null;
    return {
      node_id: row.node_id,
      display_name: row.display_name,
      endpoint_url: row.endpoint_url,
      protocol_version: Number(row.protocol_version),
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_seen_at: row.last_seen_at,
    };
  }

  listPeers() {
    return this.db.prepare('SELECT node_id FROM peer_nodes ORDER BY node_id').all()
      .map((row) => this.getPeer(row.node_id));
  }

  revokePeer(nodeId) {
    const timestamp = this.now();
    const changes = this.db.prepare(
      "UPDATE peer_nodes SET status = 'revoked', updated_at = ? WHERE node_id = ?",
    ).run(timestamp, String(nodeId)).changes;
    if (!changes) return null;
    return this.getPeer(nodeId);
  }

  requireActivePeer(nodeId) {
    const peer = this.getPeer(nodeId);
    if (!peer || peer.status !== 'active') {
      const error = new Error(`peer is not registered or has been revoked: ${nodeId}`);
      error.code = 'PEER_UNKNOWN';
      throw error;
    }
    return peer;
  }

  #touchPeer(nodeId) {
    this.db.prepare('UPDATE peer_nodes SET last_seen_at = ? WHERE node_id = ?').run(this.now(), String(nodeId));
  }

  // --- ingest ---

  // Applies a batch of events pushed by a peer. The caller's node identity is
  // transport-verified; events claiming a different origin are rejected.
  // Each event commits independently so one malformed event cannot roll back
  // the rest of the batch.
  ingest({ from_node, events }) {
    const peer = this.requireActivePeer(from_node);
    const results = [];
    let applied = 0;
    let maxSeq = 0;
    for (const event of Array.isArray(events) ? events : []) {
      const result = this.#ingestEvent(peer.node_id, event);
      results.push(result);
      if (result.status === 'applied' || result.status === 'duplicate') {
        applied += 1;
        maxSeq = Math.max(maxSeq, Number(event.seq) || 0);
      }
    }
    if (maxSeq > 0) {
      this.db.prepare(`
        INSERT INTO peer_sync_cursors (peer_node_id, inbound_cursor, outbound_acked_seq, updated_at)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(peer_node_id) DO UPDATE SET
          inbound_cursor = MAX(inbound_cursor, excluded.inbound_cursor),
          updated_at = excluded.updated_at
      `).run(peer.node_id, maxSeq, this.now());
    }
    this.#touchPeer(peer.node_id);
    return { results, applied, rejected: results.filter((r) => r.status === 'rejected').length, conflicts: results.filter((r) => r.status === 'conflict').length };
  }

  #ingestEvent(fromNode, event) {
    const receivedAt = this.now();
    if (!event || typeof event !== 'object') {
      return { event_id: null, status: 'rejected', detail: 'event must be an object' };
    }
    const { event_id, seq, entity_type, entity_id, operation, origin_node_id, payload } = event;
    if (!event_id || typeof event_id !== 'string') {
      return { event_id: null, status: 'rejected', detail: 'event_id is required' };
    }
    if (!Number.isInteger(Number(seq)) || Number(seq) < 1) {
      return { event_id, status: 'rejected', detail: 'seq must be a positive integer' };
    }
    if (origin_node_id !== fromNode) {
      return { event_id, status: 'rejected', detail: 'event origin does not match the authenticated peer' };
    }
    if (entity_type !== 'task' || !entity_id || typeof entity_id !== 'string') {
      return { event_id, status: 'rejected', detail: `unsupported entity type: ${entity_type}` };
    }
    if (!['create', 'update'].includes(operation)) {
      return { event_id, status: 'rejected', detail: `unsupported operation: ${operation}` };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { event_id, status: 'rejected', detail: 'payload must be an object' };
    }

    const outcome = transaction(this.db, () => {
      const inserted = this.db.prepare(`
        INSERT INTO peer_sync_inbox (event_id, origin_node_id, origin_seq, entity_type, entity_id, operation, payload_json, status, detail_json, received_at, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '{}', ?, NULL)
        ON CONFLICT(event_id) DO NOTHING
      `).run(
        event_id, fromNode, Number(seq), entity_type, entity_id,
        operation, JSON.stringify(payload), receivedAt,
      );
      if (!inserted.changes) return { status: 'duplicate', detail: null };

      const detail = operation === 'create'
        ? this.#applyTaskCreate(fromNode, payload)
        : this.#applyTaskUpdate(fromNode, entity_id, payload);
      const timestamp = this.now();
      this.db.prepare(
        'UPDATE peer_sync_inbox SET status = ?, detail_json = ?, applied_at = ? WHERE event_id = ?',
      ).run(detail.status, JSON.stringify(detail.detail ?? {}), detail.status === 'applied' ? timestamp : null, event_id);
      return detail;
    });
    return { event_id, ...outcome };
  }

  #applyTaskCreate(fromNode, payload) {
    try {
      const { task, idempotent_replay } = this.tasks.createFromSync({ ...payload, synced_from: fromNode });
      return { status: idempotent_replay ? 'duplicate' : 'applied', detail: { task_id: task.task_id } };
    } catch (error) {
      return { status: 'rejected', detail: { reason: error.message } };
    }
  }

  #applyTaskUpdate(fromNode, taskId, payload) {
    const local = this.tasks.get(taskId);
    if (!local) return { status: 'rejected', detail: { reason: 'task_not_found' } };
    // Execution updates are only credible from the task's executor or its
    // origin node; any other peer may not drive this task's state.
    if (local.origin_node_id !== fromNode && local.executor_node_id !== fromNode) {
      return { status: 'rejected', detail: { reason: 'unauthorized_publisher' } };
    }
    const update = {
      status: payload.status,
      result_kind: payload.result_kind ?? null,
      result: payload.result ?? null,
      session_ref: payload.session_ref ?? null,
      finished_at: payload.finished_at ?? null,
    };
    const { task, applied, reason } = this.tasks.applySyncUpdate(taskId, update);
    if (applied) return { status: 'applied', detail: { task_id: taskId, status: task.status } };
    if (reason === 'not_found') return { status: 'rejected', detail: { reason } };
    if (reason === 'terminal') {
      const sameOutcome = task.status === update.status
        && (update.status !== 'done' || task.result_kind === update.result_kind);
      return sameOutcome
        ? { status: 'duplicate', detail: { task_id: taskId, reason } }
        : { status: 'conflict', detail: { task_id: taskId, reason, local_status: task.status, remote_status: update.status } };
    }
    return { status: 'conflict', detail: { task_id: taskId, reason, local_status: task.status, remote_status: update.status } };
  }

  // --- acknowledgements ---

  // A peer confirms it has consumed our outbox through `seq`; used later for
  // outbox pruning. Inbound progress is tracked by ingest itself.
  recordAck(fromNode, seq) {
    this.requireActivePeer(fromNode);
    const acked = Number(seq);
    if (!Number.isInteger(acked) || acked < 0) {
      const error = new Error('ack seq must be a non-negative integer');
      error.code = 'PEER_ACK_INVALID';
      throw error;
    }
    this.db.prepare(`
      INSERT INTO peer_sync_cursors (peer_node_id, inbound_cursor, outbound_acked_seq, updated_at)
      VALUES (?, 0, ?, ?)
      ON CONFLICT(peer_node_id) DO UPDATE SET
        outbound_acked_seq = MAX(outbound_acked_seq, excluded.outbound_acked_seq),
        updated_at = excluded.updated_at
    `).run(String(fromNode), acked, this.now());
    this.#touchPeer(fromNode);
    return this.getCursor(fromNode);
  }

  getCursor(peerNodeId) {
    const row = this.db.prepare('SELECT * FROM peer_sync_cursors WHERE peer_node_id = ?').get(String(peerNodeId));
    if (!row) return { peer_node_id: String(peerNodeId), inbound_cursor: 0, outbound_acked_seq: 0, updated_at: null };
    return {
      peer_node_id: row.peer_node_id,
      inbound_cursor: Number(row.inbound_cursor),
      outbound_acked_seq: Number(row.outbound_acked_seq),
      updated_at: row.updated_at,
    };
  }

  status() {
    const inbox = this.db.prepare(
      'SELECT status, count(*) AS count FROM peer_sync_inbox GROUP BY status',
    ).all();
    return {
      node_id: this.nodeId,
      protocol_version: PEER_SYNC_PROTOCOL_VERSION,
      head_seq: this.headSeq(),
      peers: this.listPeers(),
      inbox: Object.fromEntries(inbox.map((row) => [row.status, Number(row.count)])),
    };
  }
}

export function createPeerSyncService(options) {
  return new PeerSyncService(options);
}
