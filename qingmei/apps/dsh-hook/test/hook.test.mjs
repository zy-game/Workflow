import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function fakeCtx() {
  const listeners = new Map()
  return {
    ctx: {
      on(name, listener) {
        listeners.set(name, listener)
      },
    },
    emit(type, session, event) {
      listeners.get(type)?.(session, event)
    },
  }
}

test('hook 直接提交到青梅：带 deviceId/token，逐轮原文不丢细节', async () => {
  const { ctx, emit } = fakeCtx()
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    apply(ctx, {
      api: 'https://qingmei.test:8710',
      token: 'test-token',
      deviceId: 'dev-dsh-pc',
    })
    emit('session/event', { id: 's1' }, { type: 'user/message', time: Date.now(), data: { text: '把会议改到周五' } })
    emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      time: Date.now(),
      data: { message: { content: [{ type: 'text', text: '好，改到周五下午三点。' }] } },
    })
    emit('session/event', { id: 's1' }, { type: 'turn/end', time: Date.now(), data: {} })
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://qingmei.test:8710/api/v1/devices/ingest')
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token')
  assert.equal(calls[0].body.deviceId, 'dev-dsh-pc')
  assert.equal(calls[0].body.turns.length, 2)
  assert.equal(calls[0].body.turns[0].text, '把会议改到周五')
  assert.match(calls[0].body.turns[1].text, /周五下午三点/)
  assert.ok(calls[0].body.summary.includes('周五下午三点'))
})
