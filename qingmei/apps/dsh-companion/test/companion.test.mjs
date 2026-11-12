import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function response(value) {
  return { ok: true, json: async () => value }
}

test('companion 领 DSH 任务并创建 GUI 会话', async () => {
  const listeners = new Map()
  const calls = []
  const agent = {
    followup(message) {
      calls.push({ kind: 'followup', message })
      const listener = listeners.get('session/event')
      listener(
        { id: createdSessionId },
        {
          type: 'assistant/message',
          time: Date.now(),
          data: { message: { content: [{ type: 'text', text: 'OK' }] } },
        },
      )
    },
    whenIdle: async () => {},
  }
  let cleanup
  let createdSessionId = ''
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
    },
    effect(callback) {
      cleanup = callback()
    },
    agents: {
      get(id) {
        return id === createdSessionId ? agent : undefined
      },
    },
    sessionController: {
      async create(options) {
        createdSessionId = String(options.sessionId)
        calls.push({ kind: 'create', options })
        return { sessionId: createdSessionId }
      },
      async selectModel() {},
    },
    workspaceRegistry: {
      async create(path) {
        calls.push({ kind: 'workspace', path })
        return { attachSession: async (id) => calls.push({ kind: 'attach', id }) }
      },
    },
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ kind: 'fetch', url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).endsWith('/devices/register')) return response({ ok: true })
    if (String(url).endsWith('/devices/claim')) {
      return response({ ok: true, task: { id: 'task-1', prompt: '只回复 OK' } })
    }
    return response({ ok: true })
  }

  try {
    apply(ctx, {
      enabled: true,
      api: 'http://127.0.0.1:1',
      token: 'test-token',
      deviceId: 'dev-test',
      workspacePath: process.cwd(),
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    cleanup?.()
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.ok(calls.some((call) => call.kind === 'create'))
  assert.ok(calls.some((call) => call.kind === 'attach' && call.id.startsWith('session-')))
  assert.ok(calls.some((call) => call.kind === 'followup'))
  const finish = calls.find((call) => call.kind === 'fetch' && call.url.endsWith('/devices/finish'))
  assert.equal(finish.body.status, 'done')
  assert.equal(finish.body.result, 'OK')
})

async function runWithTask(task) {
  const listeners = new Map()
  const calls = []
  let createdSessionId = ''
  const agent = {
    followup(message) {
      calls.push({ kind: 'followup', message })
      listeners.get('session/event')?.(
        { id: createdSessionId },
        { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: 'OK' }] } } },
      )
    },
    whenIdle: async () => {},
  }
  let cleanup
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
    },
    effect(callback) {
      cleanup = callback()
    },
    agents: {
      get(id) {
        return id === createdSessionId ? agent : undefined
      },
    },
    sessionController: {
      async create(options) {
        createdSessionId = String(options.sessionId)
        calls.push({ kind: 'create', options })
        return { sessionId: createdSessionId }
      },
      async selectModel() {},
    },
    workspaceRegistry: {
      async create(path) {
        calls.push({ kind: 'workspace', path })
        return { attachSession: async (id) => calls.push({ kind: 'attach', id }) }
      },
    },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ kind: 'fetch', url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (String(url).endsWith('/devices/register')) return response({ ok: true })
    if (String(url).endsWith('/devices/claim')) return response({ ok: true, task })
    return response({ ok: true })
  }
  try {
    apply(ctx, {
      enabled: true,
      api: 'http://127.0.0.1:1',
      token: 'test-token',
      deviceId: 'dev-test',
      workspacePath: process.cwd(),
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    cleanup?.()
  } finally {
    globalThis.fetch = originalFetch
  }
  return calls
}

test('任务带 target.cwd 时在指定目录建会话（不再回退到 workspacePath）', async () => {
  const calls = await runWithTask({
    id: 'task-cwd',
    prompt: '只回复 OK',
    target: { cwd: process.cwd(), workspaceId: 'missing-workspace' },
  })
  const create = calls.find((call) => call.kind === 'create')
  assert.ok(create)
  assert.equal(create.options.cwd, process.cwd())
})

test('只有 workspaceId 且 DSH 里找不到时拒绝执行，不在错误目录跑', async () => {
  const calls = await runWithTask({
    id: 'task-bad',
    prompt: '只回复 OK',
    target: { workspaceId: 'missing-workspace' },
  })
  assert.equal(calls.some((call) => call.kind === 'create'), false)
  const finish = calls.find((call) => call.kind === 'fetch' && call.url.endsWith('/devices/finish'))
  assert.equal(finish.body.status, 'failed')
  assert.match(finish.body.error, /工作区/)
})
