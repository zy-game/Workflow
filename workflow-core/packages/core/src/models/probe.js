// probe.js - liveness probe for registered models. A single minimal chat
// completion per model; latency and failure count feed registry demotion.
// This is the only raw-LLM HTTP call in the core - everything else goes
// through the central DSH.

function sanitizeProbeError(value, key) {
  let message = String(value ?? '');
  if (typeof key === 'string' && key) message = message.replaceAll(key, '[REDACTED]');
  return message
    .replace(/\b(?:sk|pk)[-_][A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .slice(0, 120);
}

export async function probeModel(entry, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${entry.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${entry.api_key}` },
      body: JSON.stringify({
        model: entry.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    // 4xx/5xx still proves reachability and auth state; treat non-2xx as failure.
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        detail += ` ${sanitizeProbeError(body?.error?.message || body?.error || '', entry.api_key)}`;
      } catch { /* non-JSON error body is fine */ }
      return { ok: false, latencyMs: latency, error: detail };
    }
    await response.arrayBuffer().catch(() => {});
    return { ok: true, latencyMs: latency };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: sanitizeProbeError(error.name === 'AbortError' ? 'timeout' : error.message, entry.api_key),
    };
  } finally {
    clearTimeout(timer);
  }
}

export class ProbeRunner {
  constructor({ registry, intervalMs = 5 * 60 * 1000, fetchImpl = fetch } = {}) {
    this.registry = registry;
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl;
    this.timer = null;
    this.running = false;
  }

  async probeAll() {
    const results = [];
    for (const entry of this.registry.list({ includeKey: true })) {
      if (!entry.enabled) continue;
      const outcome = await probeModel(entry, { fetchImpl: this.fetchImpl });
      const updated = this.registry.recordProbe(entry.model_id, outcome);
      results.push({ model_id: entry.model_id, model: entry.model, ...outcome, priority: updated.priority, enabled: updated.enabled });
    }
    return results;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.probeAll().catch((error) => console.error('[models] probe failed:', error.message));
    }, this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
