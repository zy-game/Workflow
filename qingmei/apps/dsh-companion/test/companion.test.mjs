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
      async create(options) {
        createdSessionId = String(options.sessionId)
        calls.push({ kind: 'create', options })
        return { agent, dispose: async () => {} }
      },
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
