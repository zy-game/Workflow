// client.js - outbound peer-sync connector. For every configured peer the
// client pulls the peer's outbox with the persisted inbound cursor, ingests
// the events locally, and acknowledges the consumed sequence so the peer can
// prune. Cursors live in core.db, so offline periods replay from where the
// node stopped. Sync tokens are provisioned by the remote peer and are only
// ever read from configuration; they are never logged.
import { PEER_SYNC_PROTOCOL_VERSION } from './service.js';

const PULL_PAGE_LIMIT = 500;
const MAX_PULL_PAGES = 20;
const REQUEST_TIMEOUT_MS = 15_000;

export function createPeerSyncClient({ peerSyncService, peers = [], nodeId = null, intervalMs = 15_000, log = () => {}, fetch = globalThis.fetch } = {}) {
  if (!peerSyncService) throw new TypeError('peerSyncService is required');
  const effectiveNodeId = nodeId ?? peerSyncService.nodeId;
  if (peers.some((peer) => peer.node_id === effectiveNodeId)) {
    throw new TypeError('a node cannot configure itself as a peer');
  }
  const byNodeId = new Map(peers.map((peer) => [peer.node_id, peer]));
  // Peers that rejected us with PEER_REVOKED are dropped for the lifetime of
  // this client; only a restart (with updated configuration) retries them.
  const revoked = new Set();
  let timer = null;
  let current = null;
  let stopped = true;

  async function post(peer, path, body) {
    const response = await fetch(`${peer.endpoint}/api/v1/peer/sync${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${peer.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`peer sync ${path} failed: ${payload.code ?? response.status}`);
      error.code = payload.code ?? 'PEER_REQUEST_FAILED';
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function get(peer, path) {
    const response = await fetch(`${peer.endpoint}/api/v1/peer/sync${path}`, {
      headers: { authorization: `Bearer ${peer.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`peer sync ${path} failed: ${payload.code ?? response.status}`);
      error.code = payload.code ?? 'PEER_REQUEST_FAILED';
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function syncPeer(peer) {
    if (revoked.has(peer.node_id)) return;
    // Key exchange runs before the first transfer: peers without a pinned
    // key handshake to publish our key and pin the remote's, so signature
    // verification covers every subsequent event.
    try {
      if (!peerSyncService.getPeer(peer.node_id)?.public_key) {
        const handshake = await post(peer, '/handshake', {
          protocol_version: PEER_SYNC_PROTOCOL_VERSION,
          public_key: peerSyncService.publicKeyBase64,
        });
        if (handshake.public_key) {
          peerSyncService.registerPeer({ node_id: peer.node_id, public_key: handshake.public_key });
        }
      }
      if (peer.pull !== false) await pullPeer(peer);
      if (peer.origins?.length) await pullRelayedOrigins(peer);
      if (peer.push) await pushPeer(peer);
    } catch (error) {
      if (error.code === 'PEER_REVOKED') {
        revoked.add(peer.node_id);
        log(`[peer-sync] ${peer.node_id}: revoked by the remote peer; stopping sync for it`);
        return;
      }
      if (error.code !== 'PEER_UNKNOWN') throw error;
      const handshake = await post(peer, '/handshake', {
        protocol_version: PEER_SYNC_PROTOCOL_VERSION,
        public_key: peerSyncService.publicKeyBase64,
      });
      if (handshake.public_key) {
        peerSyncService.registerPeer({ node_id: peer.node_id, public_key: handshake.public_key });
      }
      if (peer.pull !== false) await pullPeer(peer);
      if (peer.origins?.length) await pullRelayedOrigins(peer);
      if (peer.push) await pushPeer(peer);
    }
  }

  async function pullPeer(peer, origin = null) {
    let since = peerSyncService.getCursor(peer.node_id, origin ?? '').inbound_cursor;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const response = await post(peer, '/pull', { since_seq: since, origin, limit: PULL_PAGE_LIMIT });
      const events = Array.isArray(response.events) ? response.events : [];
      if (events.length) {
        peerSyncService.ingest({ from_node: peer.node_id, events });
      }
      since = Number(response.next_seq ?? since);
      await post(peer, '/ack', { seq: since, origin });
      if (events.length < PULL_PAGE_LIMIT) break;
    }
  }

  // Relayed origins: pin the origin's key from the relay's stream index, then
  // pull that origin's stream through the relay. Signature verification is
  // local, so the relay cannot forge or alter what it forwards.
  async function pullRelayedOrigins(peer) {
    const wanted = Array.isArray(peer.origins) ? peer.origins : [];
    if (!wanted.length) return;
    const index = await get(peer, '/origins');
    const known = new Map((index.origins ?? []).map((entry) => [entry.node_id, entry.public_key]));
    for (const origin of wanted) {
      const publicKey = known.get(origin);
      if (publicKey && peerSyncService.getPeer(origin)?.public_key !== publicKey) {
        peerSyncService.registerPeer({ node_id: origin, public_key: publicKey });
      }
      await pullPeer(peer, origin);
    }
  }

  // Push complements pull for peers that cannot accept inbound connections:
  // the sender drives the transfer and the receiver's echoed inbound_cursor
  // doubles as the acknowledgement, so no second connection is needed.
  async function pushPeer(peer) {
    let since = peerSyncService.getCursor(peer.node_id).outbound_acked_seq;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const events = peerSyncService.eventsSince(since, { limit: PULL_PAGE_LIMIT });
      if (!events.length) break;
      const response = await post(peer, '/push', { events });
      const cursor = Number(response.inbound_cursor ?? 0);
      if (Number.isInteger(cursor) && cursor > since) {
        peerSyncService.recordAck(peer.node_id, cursor);
        since = cursor;
      }
      if (events.length < PULL_PAGE_LIMIT) break;
    }
  }

  // A concurrent caller joins the in-flight round instead of skipping it, so
  // an awaited tick() always reflects events published before it was called.
  function tick() {
    if (current) return current;
    current = (async () => {
      try {
        for (const peer of peers) {
          try {
            await syncPeer(peer);
          } catch (error) {
            log(`[peer-sync] ${peer.node_id}: ${error.message}${error.cause ? `: ${error.cause}` : ''}`);
          }
        }
        peerSyncService.pruneAcked();
      } finally {
        current = null;
      }
    })();
    return current;
  }

  return {
    nodeId: effectiveNodeId,
    peers: [...byNodeId.keys()],
    revokedPeers: () => [...revoked],
    start() {
      if (!stopped) return;
      stopped = false;
      for (const peer of peers) {
        peerSyncService.registerPeer({
          node_id: peer.node_id,
          endpoint: peer.endpoint,
          protocol_version: PEER_SYNC_PROTOCOL_VERSION,
        });
      }
      timer = setInterval(() => { tick().catch((error) => log(`[peer-sync] tick failed: ${error.message}`)); }, intervalMs);
      timer.unref?.();
      tick().catch((error) => log(`[peer-sync] initial tick failed: ${error.message}`));
    },
    async stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      while (current) await current.catch(() => {});
    },
    tick,
  };
}
