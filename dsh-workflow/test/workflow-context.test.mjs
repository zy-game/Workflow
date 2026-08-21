import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, createContextProvider } from '../workflow-context.mjs'

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function fakeCtx() {
  const ctx = {
    sections: null,
    listeners: new Map(),
    systemPrompt: {
      section(value) { ctx.sections = value },
    },
    on(name, listener) { ctx.listeners.set(name, listener) },
  }
  return ctx
}

const SESSION = { id: 's1', cwd: '/srv/project' }

function preStepEvent(ctx, { agent, step = 1, signal, decision = { kind: 'enter', messages: [] } } = {}) {
  const listener = ctx.listeners.get('agent/pre-step')
  assert.ok(listener, 'apply must register agent/pre-step')
  const next = async () => decision
  return listener({ agent: agent ?? { session: { header: SESSION } }, step, signal }, next)
}

test('posts the internal provider contract without authorization', async () => {
  const calls = []
  const provider = createContextProvider({}, {
    fetchImpl: async (...args) => {
      calls.push(args)
      return response({ ok: true, revision: 7, project: { id: 'p1', name: 'Project' }, context_text: 'injected' })
    },
  })

  const text = await provider({ cwd: '/srv/project', sessionId: 's1' })

  assert.equal(text, 'injected')
  assert.equal(calls[0][0], 'http://127.0.0.1:18711/api/internal/v1/workflow/context')
  assert.deepEqual(calls[0][1].headers, { 'content-type': 'application/json', accept: 'application/json' })
  assert.deepEqual(JSON.parse(calls[0][1].body), { cwd: '/srv/project', max_chars: 6000, session_id: 's1' })
})

test('caches context by resolved project id and revision', async () => {
  const bodies = [
    { ok: true, revision: 3, project: { id: 'p1', name: 'Project' }, context_text: 'revision 3' },
    { ok: true, revision: 3, project: { id: 'p1', name: 'Renamed' }, context_text: 'must not replace cached revision' },
    { ok: true, revision: 4, project: { id: 'p1', name: 'Renamed' }, context_text: 'revision 4' },
  ]
  const requests = []
  const provider = createContextProvider({}, {
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return response(bodies.shift())
    },
  })

  assert.equal(await provider({ cwd: '/srv/project' }), 'revision 3')
  assert.equal(await provider({ cwd: '/srv/project' }), 'revision 3')
  assert.equal(await provider({ cwd: '/srv/project' }), 'revision 4')
  assert.equal(requests[1].project_id, 'p1')
  assert.equal(requests[2].project_id, 'p1')
})

test('provider failures degrade to a null fetch result and keep the last good cache', async () => {
  const warnings = []
  const provider = createContextProvider({}, {
    fetchImpl: async () => response({ ok: false, error: 'not found' }, 404),
    log: { warn(message) { warnings.push(message) } },
  })
  assert.equal(await provider({ cwd: '/missing' }), null)
  assert.match(warnings[0], /not found/)
})

test('section text is synchronous and empty before the first pre-step refresh', () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.equal(ctx.sections.name, 'workflow-context')
  assert.equal(ctx.sections.order, 50)
  assert.equal(typeof ctx.sections.text, 'function')
  assert.equal(ctx.sections.text.constructor.name, 'Function')
  assert.equal(ctx.sections.text({ agent: { session: { header: SESSION } } }), '')
})

test('pre-step refresh on step one makes the fetched context visible to the section', async () => {
  const ctx = fakeCtx()
  apply(ctx, {}, { fetchImpl: async () => response({ ok: true, revision: 5, project: null, context_text: 'ctx-body' }) })
  const decision = await preStepEvent(ctx)
  assert.equal(decision.kind, 'enter')
  assert.equal(ctx.sections.text({ agent: { session: { header: SESSION } } }), 'ctx-body')
})

test('pre-step skips fetch on later steps, rejection, and abort', async () => {
  let fetched = 0
  const ctx = fakeCtx()
  apply(ctx, {}, { fetchImpl: async () => { fetched += 1; return response({ ok: true, revision: 5, project: null, context_text: 'ctx' }) } })

  await preStepEvent(ctx, { step: 2 })
  assert.equal(fetched, 0)

  await preStepEvent(ctx, { decision: { kind: 'reject', reason: 'nope' } })
  assert.equal(fetched, 0)

  await preStepEvent(ctx, { signal: { aborted: true } })
  assert.equal(fetched, 0)

  await preStepEvent(ctx)
  assert.equal(fetched, 1)
  assert.equal(ctx.sections.text({ agent: { session: { header: SESSION } } }), 'ctx')
})
