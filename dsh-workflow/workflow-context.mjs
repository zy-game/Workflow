export const name = 'workflow-context'
export const inject = ['systemPrompt']

const DEFAULTS = {
  providerUrl: 'http://127.0.0.1:18711/api/internal/v1/workflow/context',
  maxChars: 6000,
}

function identityFrom(agent) {
  const header = agent?.session?.header ?? agent?.header
  return {
    cwd: header?.cwd,
    sessionId: header?.id,
  }
}

function validateSuccess(body) {
  if (body?.ok !== true) throw new Error(body?.error || 'provider returned an invalid response')
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('provider response has an invalid revision')
  if (typeof body.context_text !== 'string') throw new Error('provider response has no context_text')
  if (body.project !== null && (
    typeof body.project !== 'object'
    || typeof body.project.id !== 'string'
    || typeof body.project.name !== 'string'
  )) throw new Error('provider response has an invalid project')
  return body
}

// Fetches workflow context for one session. The provider is async and must
// never be handed to systemPrompt.section directly: the prompt assembler
// invokes section text functions synchronously, and a Promise there aborts
// every turn with "text.indexOf is not a function".
export function createContextProvider(config = {}, { fetchImpl = globalThis.fetch, log = console } = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (typeof fetchImpl !== 'function') throw new Error('workflow-context requires fetch')
  const contextByRevision = new Map()
  const projectByCwd = new Map()

  return async ({ cwd, sessionId }) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return ''
    const payload = { cwd, max_chars: cfg.maxChars }
    const projectId = projectByCwd.get(cwd)
    if (projectId) payload.project_id = projectId
    if (typeof sessionId === 'string' && sessionId.length > 0) payload.session_id = sessionId

    try {
      const response = await fetchImpl(cfg.providerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      let body
      try { body = await response.json() } catch { body = null }
      if (!response.ok) throw new Error(body?.error || `provider HTTP ${response.status}`)
      const result = validateSuccess(body)
      const resolvedProjectId = result.project?.id ?? 'none'
      if (result.project) projectByCwd.set(cwd, result.project.id)
      const key = `${resolvedProjectId}:${result.revision}`
      if (!contextByRevision.has(key)) contextByRevision.set(key, result.context_text)
      return contextByRevision.get(key)
    } catch (error) {
      log.warn?.(`[workflow-context] ${error.message}`)
      return null
    }
  }
}

// The section reads the per-session cache synchronously; agent/pre-step (the
// only async-safe hook) refreshes the cache at the start of every turn.
export function apply(ctx, config = {}, { fetchImpl = globalThis.fetch, log = console } = {}) {
  const fetchContext = createContextProvider(config, { fetchImpl, log })
  const cache = new Map()

  const cachedText = (agent) => {
    const { cwd, sessionId } = identityFrom(agent)
    if (typeof cwd !== 'string' || cwd.length === 0) return ''
    return cache.get(sessionId ?? cwd) ?? ''
  }

  ctx.systemPrompt.section({
    name: 'workflow-context',
    order: 50,
    text: (context) => cachedText(context?.agent),
  })

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal?.aborted || step !== 1) return decision
    const { cwd, sessionId } = identityFrom(agent)
    if (typeof cwd !== 'string' || cwd.length === 0) return decision
    const text = await fetchContext({ cwd, sessionId })
    if (text) cache.set(sessionId ?? cwd, text)
    return decision
  })
}
