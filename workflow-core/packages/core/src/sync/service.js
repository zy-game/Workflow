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
import { publicKeyFromBase64, signEvent, verifyEvent } from './sync-key.js';

export const PEER_SYNC_PROTOCOL_VERSION = 1;

// Task events that carry a decision worth projecting onto peer nodes.
// Claim/lease/progress/session events are execution-local to the worker
// connection that holds the claim, but claim and progress are also projected
// so peer task lists see live dispatched/running state.
const SYNCED_TASK_EVENTS = new Set([
  'created', 'claimed', 'progress', 'done', 'cancelled', 'dead_letter', 'awaiting_input',
]);

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
    sig: row.sig ?? null,
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
  // join the domain transaction that produced them. The knowledge repository
  // is optional and enables project-registry synchronization.
  constructor({ coreDb, nodeId, taskRepository, knowledgeRepository = null, signingKey = null, relay = false, now = () => new Date().toISOString() } = {}) {
    if (!coreDb?.db) throw new TypeError('coreDb is required');
    if (!NODE_ID_PATTERN.test(String(nodeId ?? ''))) throw new TypeError('a valid nodeId is required');
    if (!taskRepository) throw new TypeError('taskRepository is required');
    this.db = coreDb.db;
    this.nodeId = String(nodeId);
    this.tasks = taskRepository;
    this.knowledge = knowledgeRepository;
    this.signingKey = signingKey;
    this.relay = Boolean(relay);
    this.now = now;
    this.unsubscribe = taskRepository.onEvent((event) => this.#onTaskEvent(event));
    this.unsubscribeKnowledge = knowledgeRepository
      ? knowledgeRepository.onChange((change) => this.#onKnowledgeChange(change))
      : null;
  }

  close() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeKnowledge?.();
    this.unsubscribeKnowledge = null;
  }

  // --- publishing ---

  // Project events announce the registry to peers. Only the owner node
  // publishes: a project without an owner is local-only until ownership is
  // assigned. Machine-local locations never leave the node.
  #onKnowledgeChange(change) {
    if (change.entityType !== 'project') return;
    const record = change.record;
    const owner = record?.metadata?.owner_node_id ?? record?.metadata?.ownerNodeId ?? null;
    if (owner !== this.nodeId) return;
    this.#publish({
      entity_type: 'project',
      entity_id: record.id,
      operation: change.operation === 'create' ? 'create' : 'update',
      payload: {
        id: record.id,
        name: record.name,
        type: record.type,
        goal: record.goal,
        status: record.status,
        metadata: record.metadata ?? {},
      },
    });
  }

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
          : event.type === 'claimed' ? 'dispatched'
            : event.type === 'progress' ? 'running'
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
        note: event.payload?.note ?? null,
        percent: event.payload?.percent ?? null,
      },
    });
  }

  #publish({ entity_type, entity_id, operation, payload }) {
    // Two-phase insert: the outbox seq is assigned by SQLite, and the
    // signature must cover the final event including that seq. Both
    // statements join the caller's transaction.
    const eventId = `pse-${crypto.randomUUID()}`;
    const createdAt = this.now();
    const inserted = this.db.prepare(`
      INSERT INTO peer_sync_outbox (event_id, origin_node_id, entity_type, entity_id, operation, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, this.nodeId, entity_type, entity_id, operation, JSON.stringify(payload ?? {}), createdAt);
    if (!this.signingKey) return;
    const seq = Number(inserted.lastInsertRowid);
    const sig = signEvent(this.signingKey.privateKey, {
      event_id: eventId,
      seq,
      origin_node_id: this.nodeId,
      entity_type,
      entity_id,
      operation,
      payload: payload ?? {},
      created_at: createdAt,
    });
    this.db.prepare('UPDATE peer_sync_outbox SET sig = ? WHERE seq = ?').run(sig, seq);
  }

  headSeq() {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM peer_sync_outbox').get().head);
  }

  // Without `origin`, serves this node's own outbox. With `origin`, serves the
  // relay stream for that origin node (relay mode): events are forwarded
  // verbatim, preserving the origin's seq and signature.
  eventsSince(sinceSeq, { limit = 500, origin = null } = {}) {
    const cursor = Number(sinceSeq ?? 0);
    const bounded = Math.min(2000, Math.max(1, Number(limit) || 500));
    if (origin != null) {
      return this.db.prepare(
        'SELECT * FROM peer_relay_outbox WHERE origin_node_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      ).all(String(origin), cursor, bounded).map(wireEventFromRow);
    }
    return this.db.prepare(
      'SELECT * FROM peer_sync_outbox WHERE seq > ? ORDER BY seq ASC LIMIT ?',
    ).all(cursor, bounded).map(wireEventFromRow);
  }

  // Origins available through the relay stream, with their pinned public keys
  // so pullers can verify forwarded signatures without contacting the origin.
  relayOrigins() {
    return this.db.prepare(`
      SELECT DISTINCT r.origin_node_id AS node_id, p.public_key
      FROM peer_relay_outbox r
      LEFT JOIN peer_nodes p ON p.node_id = r.origin_node_id
      ORDER BY r.origin_node_id
    `).all().map((row) => ({ node_id: row.node_id, public_key: row.public_key ?? null }));
  }

  // --- peer registry ---

  registerPeer({ node_id, endpoint = null, display_name = null, protocol_version = PEER_SYNC_PROTOCOL_VERSION, public_key = undefined } = {}) {
    const peerId = String(node_id ?? '').trim();
    if (!NODE_ID_PATTERN.test(peerId)) throw new TypeError('node_id must match ^[a-z][a-z0-9._-]{2,63}$');
    if (!isPeerProtocolSupported(protocol_version)) {
      const error = new Error(`unsupported peer protocol version: ${protocol_version}`);
      error.code = 'PEER_PROTOCOL_UNSUPPORTED';
      throw error;
    }
    let pinnedKey = null;
    if (public_key != null) {
      try {
        publicKeyFromBase64(String(public_key));
      } catch {
        throw new TypeError('public_key must be a base64 SPKI ed25519 key');
      }
      pinnedKey = String(public_key);
    }
    // Revocation is sticky: a revoked peer cannot re-register (a handshake
    // must never resurrect it) and only activatePeer() restores access.
    const existing = this.getPeer(peerId);
    if (existing?.status === 'revoked') {
      const error = new Error(`peer is revoked and must be explicitly re-activated: ${peerId}`);
      error.code = 'PEER_REVOKED';
      throw error;
    }
    // A pinned key is immutable: a changed key for a known node is exactly
    // what key substitution looks like. Only an operator clearing the pin
    // in the registry may rotate a key.
    if (existing?.public_key && pinnedKey && existing.public_key !== pinnedKey) {
      const error = new Error(`peer public key does not match the pinned key: ${peerId}`);
      error.code = 'PEER_KEY_MISMATCH';
      throw error;
    }
    const timestamp = this.now();
    this.db.prepare(`
      INSERT INTO peer_nodes (node_id, display_name, endpoint_url, protocol_version, status, created_at, updated_at, last_seen_at, public_key)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, display_name),
        endpoint_url = COALESCE(excluded.endpoint_url, endpoint_url),
        protocol_version = excluded.protocol_version,
        status = 'active',
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at,
        public_key = COALESCE(peer_nodes.public_key, excluded.public_key)
    `).run(peerId, display_name, endpoint, Number(protocol_version), timestamp, timestamp, timestamp, pinnedKey);
    return this.getPeer(peerId);
  }

  // Explicit administrative re-activation of a previously revoked peer.
  activatePeer(nodeId) {
    const timestamp = this.now();
    const changes = this.db.prepare(
      "UPDATE peer_nodes SET status = 'active', updated_at = ? WHERE node_id = ? AND status = 'revoked'",
    ).run(timestamp, String(nodeId)).changes;
    if (!changes) return this.getPeer(nodeId);
    return this.getPeer(nodeId);
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
      public_key: row.public_key ?? null,
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
    if (!peer) {
      const error = new Error(`peer is not registered: ${nodeId}`);
      error.code = 'PEER_UNKNOWN';
      throw error;
    }
    if (peer.status !== 'active') {
      const error = new Error(`peer has been revoked: ${nodeId}`);
      error.code = 'PEER_REVOKED';
      throw error;
    }
    return peer;
  }

  #touchPeer(nodeId) {
    this.db.prepare('UPDATE peer_nodes SET last_seen_at = ? WHERE node_id = ?').run(this.now(), String(nodeId));
  }

  // --- ingest ---

  // Applies a batch of events pushed by a peer. The caller's node identity is
  // transport-verified; events claiming another origin are accepted only as
  // relayed traffic and must verify against the ORIGIN's pinned key. Each
  // event commits independently so one malformed event cannot roll back the
  // rest of the batch.
  ingest({ from_node, events }) {
    const peer = this.requireActivePeer(from_node);
    const results = [];
    let applied = 0;
    let rejected = 0;
    let conflicts = 0;
    const streamHeads = new Map();
    for (const event of Array.isArray(events) ? events : []) {
      const result = this.#ingestEvent(peer, event);
      results.push(result);
      if (result.status === 'applied' || result.status === 'duplicate') {
        applied += 1;
        const origin = event.origin_node_id;
        const stream = origin === peer.node_id ? '' : origin;
        streamHeads.set(stream, Math.max(streamHeads.get(stream) ?? 0, Number(event.seq) || 0));
      } else if (result.status === 'rejected') {
        rejected += 1;
      } else if (result.status === 'conflict') {
        conflicts += 1;
      }
    }
    for (const [stream, head] of streamHeads) {
      this.db.prepare(`
        INSERT INTO peer_sync_cursors (peer_node_id, origin_node_id, inbound_cursor, outbound_acked_seq, updated_at)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(peer_node_id, origin_node_id) DO UPDATE SET
          inbound_cursor = MAX(inbound_cursor, excluded.inbound_cursor),
          updated_at = excluded.updated_at
      `).run(peer.node_id, stream, head, this.now());
    }
    this.#touchPeer(peer.node_id);
    return { results, applied, rejected, conflicts };
  }

  #ingestEvent(peer, event) {
    const fromNode = peer.node_id;
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
    const relayed = origin_node_id !== fromNode;
    // Relayed events (origin != caller) are how a store-and-forward relay
    // serves unreachable origins; they must verify against the ORIGIN's
    // pinned key so the relay cannot forge or tamper. A puller that has never
    // pinned the origin's key fails closed instead of trusting the relay.
    if (relayed && !this.relayForwardable(origin_node_id)) {
      return { event_id, status: 'rejected', detail: { reason: 'origin_key_unknown' } };
    }
    const verificationKey = relayed
      ? this.getPeer(origin_node_id)?.public_key
      : peer.public_key;
    if (verificationKey) {
      const verified = verifyEvent(publicKeyFromBase64(verificationKey), {
        event_id,
        seq: Number(seq),
        origin_node_id,
        entity_type,
        entity_id,
        operation,
        payload: payload ?? {},
        created_at: event.created_at,
      }, event.sig);
      if (!verified) {
        return { event_id, status: 'rejected', detail: { reason: 'bad_signature' } };
      }
    }
    if (!['task', 'project'].includes(entity_type) || !entity_id || typeof entity_id !== 'string') {
      return { event_id, status: 'rejected', detail: `unsupported entity type: ${entity_type}` };
    }
    if (!['create', 'update'].includes(operation)) {
      return { event_id, status: 'rejected', detail: `unsupported operation: ${operation}` };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { event_id, status: 'rejected', detail: 'payload must be an object' };
    }
    if (entity_type === 'project' && !this.knowledge) {
      return { event_id, status: 'rejected', detail: { reason: 'knowledge_repository_unavailable' } };
    }

    const outcome = transaction(this.db, () => {
      const inserted = this.db.prepare(`
        INSERT INTO peer_sync_inbox (event_id, origin_node_id, origin_seq, entity_type, entity_id, operation, payload_json, status, detail_json, received_at, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '{}', ?, NULL)
        ON CONFLICT(event_id) DO NOTHING
      `).run(
        event_id, origin_node_id, Number(seq), entity_type, entity_id,
        operation, JSON.stringify(payload), receivedAt,
      );
      if (!inserted.changes) {
        this.#relayStore(event, origin_node_id);
        return { status: 'duplicate', detail: null };
      }

      const detail = entity_type === 'task'
        ? (operation === 'create'
          ? this.#applyTaskCreate(fromNode, payload)
          : this.#applyTaskUpdate(origin_node_id, entity_id, payload))
        : this.#applyProjectEvent(origin_node_id, entity_id, operation, payload);
      const timestamp = this.now();
      this.db.prepare(
        'UPDATE peer_sync_inbox SET status = ?, detail_json = ?, applied_at = ? WHERE event_id = ?',
      ).run(detail.status, JSON.stringify(detail.detail ?? {}), detail.status === 'applied' ? timestamp : null, event_id);
      // Relay mode: forward direct events verbatim so unreachable peers can
      // pull them later. Relayed events are never re-relayed (no amplification).
      if (!relayed && ['applied', 'duplicate'].includes(detail.status)) {
        this.#relayStore(event, origin_node_id);
      }
      return detail;
    });
    return { event_id, ...outcome };
  }

  // A relayed event is ingestable only when this node already pins the
  // origin's public key; otherwise the relay would be trusted to introduce
  // arbitrary origins.
  relayForwardable(originNodeId) {
    return Boolean(this.getPeer(originNodeId)?.public_key);
  }

  #relayStore(event, originNodeId) {
    if (!this.relay || event.origin_node_id !== originNodeId) return;
    this.db.prepare(`
      INSERT INTO peer_relay_outbox (origin_node_id, seq, event_id, entity_type, entity_id, operation, payload_json, created_at, sig)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(origin_node_id, seq) DO NOTHING
    `).run(
      originNodeId, Number(event.seq), event.event_id, event.entity_type, event.entity_id,
      event.operation, JSON.stringify(event.payload ?? {}), event.created_at ?? this.now(), event.sig ?? null,
    );
  }

  // Project events are only credible from the project's owner node; the
  // payload must carry that ownership so a peer cannot re-announce someone
  // else's project. Updates self-heal a missed create by projecting first.
  #applyProjectEvent(fromNode, projectId, operation, payload) {
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    const owner = metadata.owner_node_id ?? metadata.ownerNodeId ?? null;
    if (owner !== fromNode) {
      return { status: 'rejected', detail: { reason: 'unauthorized_publisher' } };
    }
    const fields = {
      name: payload.name,
      type: payload.type,
      goal: payload.goal,
      status: payload.status,
      metadata,
    };
    try {
      if (operation === 'create') {
        const { project, idempotent_replay } = this.knowledge.createProjectFromSync({ id: projectId, ...fields });
        return { status: idempotent_replay ? 'duplicate' : 'applied', detail: { project_id: project.id } };
      }
      const local = this.knowledge.getProject(projectId);
      if (!local) {
        const { project } = this.knowledge.createProjectFromSync({ id: projectId, ...fields });
        return { status: 'applied', detail: { project_id: project.id, healed: 'missing_create' } };
      }
      const localOwner = local.metadata?.owner_node_id ?? local.metadata?.ownerNodeId ?? null;
      if (localOwner && localOwner !== fromNode) {
        return { status: 'rejected', detail: { reason: 'unauthorized_publisher' } };
      }
      const project = this.knowledge.updateProject(projectId, fields);
      return { status: 'applied', detail: { project_id: project.id } };
    } catch (error) {
      return { status: 'rejected', detail: { reason: error.message } };
    }
  }

  #applyTaskCreate(originNodeId, payload) {
    try {
      const { task, idempotent_replay } = this.tasks.createFromSync({ ...payload, synced_from: originNodeId });
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
      note: payload.note ?? null,
      percent: payload.percent ?? null,
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

  // A peer confirms it has consumed a stream through `seq`. The empty origin
  // names this node's own outbox; a non-empty origin names a relay stream.
  // Inbound progress is tracked by ingest itself.
  recordAck(fromNode, seq, origin = '') {
    this.requireActivePeer(fromNode);
    const acked = Number(seq);
    if (!Number.isInteger(acked) || acked < 0) {
      const error = new Error('ack seq must be a non-negative integer');
      error.code = 'PEER_ACK_INVALID';
      throw error;
    }
    this.db.prepare(`
      INSERT INTO peer_sync_cursors (peer_node_id, origin_node_id, inbound_cursor, outbound_acked_seq, updated_at)
      VALUES (?, '', 0, ?, ?)
      ON CONFLICT(peer_node_id, origin_node_id) DO UPDATE SET
        outbound_acked_seq = MAX(outbound_acked_seq, excluded.outbound_acked_seq),
        updated_at = excluded.updated_at
    `).run(String(fromNode), acked, this.now());
    this.#touchPeer(fromNode);
    return this.getCursor(fromNode);
  }

  getCursor(peerNodeId, origin = '') {
    const row = this.db.prepare(
      'SELECT * FROM peer_sync_cursors WHERE peer_node_id = ? AND origin_node_id = ?',
    ).get(String(peerNodeId), String(origin ?? ''));
    if (!row) return { peer_node_id: String(peerNodeId), origin_node_id: String(origin ?? ''), inbound_cursor: 0, outbound_acked_seq: 0, updated_at: null };
    return {
      peer_node_id: row.peer_node_id,
      origin_node_id: row.origin_node_id,
      inbound_cursor: Number(row.inbound_cursor),
      outbound_acked_seq: Number(row.outbound_acked_seq),
      updated_at: row.updated_at,
    };
  }

  // Every tracked stream cursor, for the operations surface.
  cursors() {
    return this.db.prepare(
      'SELECT * FROM peer_sync_cursors ORDER BY peer_node_id, origin_node_id',
    ).all().map((row) => ({
      peer_node_id: row.peer_node_id,
      origin_node_id: row.origin_node_id,
      inbound_cursor: Number(row.inbound_cursor),
      outbound_acked_seq: Number(row.outbound_acked_seq),
      updated_at: row.updated_at,
    }));
  }

  // Drops outbox events confirmed by every active peer, and relay-stream
  // events confirmed by every active puller of that stream. The slowest
  // consumer bounds retention; peers without a cursor row do not constrain
  // pruning and bootstrap from the live head.
  pruneAcked() {
    const acked = this.db.prepare(`
      SELECT MIN(outbound_acked_seq) AS acked
      FROM peer_sync_cursors c
      JOIN peer_nodes p ON p.node_id = c.peer_node_id AND p.status = 'active'
      WHERE c.origin_node_id = ''
    `).get().acked;
    let pruned = 0;
    if (acked) {
      pruned += this.db.prepare('DELETE FROM peer_sync_outbox WHERE seq <= ?').run(Number(acked)).changes;
    }
    for (const row of this.db.prepare(
      'SELECT DISTINCT origin_node_id AS origin FROM peer_relay_outbox',
    ).all()) {
      const relayAcked = this.db.prepare(`
        SELECT MIN(outbound_acked_seq) AS acked
        FROM peer_sync_cursors c
        JOIN peer_nodes p ON p.node_id = c.peer_node_id AND p.status = 'active'
        WHERE c.origin_node_id = ? AND c.outbound_acked_seq > 0
      `).get(row.origin).acked;
      if (relayAcked) {
        pruned += this.db.prepare(
          'DELETE FROM peer_relay_outbox WHERE origin_node_id = ? AND seq <= ?',
        ).run(row.origin, Number(relayAcked)).changes;
      }
    }
    return pruned;
  }

  get publicKeyBase64() {
    return this.signingKey ? this.signingKey.publicKeyBase64 : null;
  }

  status() {
    const inbox = this.db.prepare(
      'SELECT status, count(*) AS count FROM peer_sync_inbox GROUP BY status',
    ).all();
    return {
      node_id: this.nodeId,
      protocol_version: PEER_SYNC_PROTOCOL_VERSION,
      signing: Boolean(this.signingKey),
      public_key: this.publicKeyBase64,
      relay: this.relay,
      relay_origins: this.relay ? this.relayOrigins().map((row) => row.node_id) : [],
      head_seq: this.headSeq(),
      peers: this.listPeers(),
      inbox: Object.fromEntries(inbox.map((row) => [row.status, Number(row.count)])),
    };
  }
}

export function createPeerSyncService(options) {
  return new PeerSyncService(options);
}
