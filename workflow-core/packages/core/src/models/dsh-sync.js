// dsh-sync.js - applies the registry's preferred model to the central DSH.
// Credential material goes only to the loopback DSH credential service.
import crypto from 'node:crypto';
import { applyDshModel } from '@workflow-core/shared';

export class DshLocalClient {
  constructor({ baseUrl = 'http://127.0.0.1:3081', fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async call(method, payload = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    });
    if (!response.ok) throw new Error(`DSH ${method} HTTP ${response.status}`);
    const body = await response.json();
    if (body?.type !== 'server-response') throw new Error(`DSH ${method}: bad envelope`);
    if (!body.result?.ok) {
      const error = new Error(`DSH ${method}: ${body.result?.error?.code ?? 'error'} ${body.result?.error?.message ?? ''}`.trim());
      error.code = body.result?.error?.code ?? 'DSH_REQUEST_FAILED';
      error.method = method;
      throw error;
    }
    return body.result.value;
  }
}

export class DshModelSync {
  constructor({ client = new DshLocalClient(), log = () => {} } = {}) {
    this.client = client;
    this.log = log;
    this.lastSyncedKey = null;
  }

  async syncTopModel(registry) {
    const [top] = registry.pushList();
    if (!top) return { synced: false, reason: 'registry_empty' };
    const identity = `${top.provider}:${top.model}:${top.key}`;
    if (identity === this.lastSyncedKey) return { synced: false, reason: 'already_active' };
    await applyDshModel(this.client, top);
    this.lastSyncedKey = identity;
    this.log(`[dsh-sync] active model ${top.provider}/${top.model}`);
    return { synced: true, provider: top.provider, model: top.model };
  }
}
