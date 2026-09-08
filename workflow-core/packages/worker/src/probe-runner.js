// probe-runner.js - bounded, read-only status investigation on the executor.
//
// A probe is not a task: it never claims a lease, never mutates the
// workspace, and it always answers. If no backend can produce an
// evidence-backed verdict inside the budget, the answer is "unknown" - which
// the caller treats as "could not determine", never as "done".
const DEFAULT_BUDGET_MS = 60_000;
const MIN_BUDGET_MS = 1_000;
const VERDICTS = new Set(['done', 'not_done', 'unknown']);

function normalizeVerdict(value) {
  return VERDICTS.has(value) ? value : 'unknown';
}

export class ProbeRunner {
  constructor({
    core, backendRegistry, projectRegistry = null, log = () => {},
    backendKind = null, maxConcurrent = 2,
  } = {}) {
    if (!core || !backendRegistry) throw new TypeError('core and backendRegistry are required');
    this.core = core;
    this.backends = backendRegistry;
    this.projects = projectRegistry;
    this.log = log;
    this.backendKind = backendKind;
    this.maxConcurrent = maxConcurrent;
    this.active = new Set();
  }

  #pick(request) {
    const kind = request.backend_kind ?? this.backendKind;
    if (kind) return this.backends.get(kind);
    const [first] = this.backends.kinds();
    return first ? this.backends.get(first) : null;
  }

  handle(request) {
    if (!request?.probe_id) return Promise.resolve(false);
    if (this.active.size >= this.maxConcurrent) {
      // Answer immediately instead of queueing a stale investigation behind
      // other work: a late verdict is worse than an honest "unknown".
      return Promise.resolve(this.#answer(request.probe_id, { verdict: 'unknown', confidence: null, evidence: [] }));
    }
    const pending = this.#investigate(request).finally(() => this.active.delete(pending));
    this.active.add(pending);
    return pending;
  }

  async #investigate(request) {
    const probeId = String(request.probe_id);
    const budgetMs = Math.max(MIN_BUDGET_MS, Number(request.budget_ms) || DEFAULT_BUDGET_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    timer.unref?.();
    try {
      const entry = this.#pick(request);
      if (!entry?.backend?.investigate) {
        return this.#answer(probeId, { verdict: 'unknown', confidence: null, evidence: [] });
      }
      const project = request.project_id && request.project_id !== 'default'
        ? this.projects?.resolve(request.project_id)
        : null;
      const result = await entry.backend.investigate({
        probeId,
        projectId: request.project_id ?? null,
        question: String(request.question ?? ''),
        refs: Array.isArray(request.refs) ? request.refs : [],
        workspace: project?.root ?? null,
        budgetMs,
        signal: controller.signal,
      });
      return this.#answer(probeId, {
        verdict: normalizeVerdict(result?.verdict),
        confidence: typeof result?.confidence === 'number' ? result.confidence : null,
        evidence: Array.isArray(result?.evidence) ? result.evidence : [],
        suggestedReply: typeof result?.suggestedReply === 'string' ? result.suggestedReply : null,
      });
    } catch (error) {
      this.log(`[worker] probe ${probeId} investigation failed: ${error.message}`);
      return this.#answer(probeId, { verdict: 'unknown', confidence: null, evidence: [] });
    } finally {
      clearTimeout(timer);
    }
  }

  #answer(probeId, { verdict, confidence, evidence, suggestedReply = null }) {
    return this.core.send('probe_result', {
      probe_id: probeId,
      verdict,
      confidence,
      evidence,
      suggested_reply: suggestedReply,
    });
  }
}
