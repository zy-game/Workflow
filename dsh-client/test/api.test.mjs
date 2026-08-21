import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { Api, AuthSession } from '../vendor/dsh-neotui/src/api.js'

function rpc(value, rpcId = null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ type: 'server-response', rpcId, result: { ok: true, value } }),
  }
}

test('login is posted outside the gateway and authenticated calls use the gateway bearer token', async () => {
  const calls = []
  const api = new Api({
    base: 'https://139.155.78.241:8710/dsh',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/api/v1/auth/client-login')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'memory-only', token_type: 'bearer' }) }
      }
      return rpc({ provider: 'mock' })
    },
  })
  await api.login('user@example.com', 'secret')
  await api.call('host.describe')

  assert.equal(calls[0].url, 'https://139.155.78.241:8710/api/v1/auth/client-login')
  assert.equal(calls[1].url, 'https://139.155.78.241:8710/dsh/api/host.describe')
  assert.equal(calls[1].init.headers.authorization, 'Bearer memory-only')
})

test('401 clears the in-memory token and requests login', async () => {
  const auth = new AuthSession()
  auth.setLogin({ access_token: 'short-lived' })
  const statuses = []
  const api = new Api({
    auth,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'expired' }) }),
    onAuthRequired: (status) => statuses.push(status),
  })
  await assert.rejects(api.call('session.list'), /auth-required/)
  assert.equal(auth.authenticated, false)
  assert.deepEqual(statuses, [401])
})

test('logical export pages history, sends auth, and verifies attachments', async () => {
  const bytes = Buffer.from('attachment payload')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const calls = []
  const auth = new AuthSession()
  auth.setLogin({ access_token: 'export-token' })
  const api = new Api({
    auth,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ body, authorization: init.headers.authorization })
      if (body.method === 'session.history' && body.payload.beforeSeq === undefined) {
        return rpc({
          header: { id: 's1', cwd: '/srv/project' },
          projections: { values: { title: 'Session' } },
          hasMore: true,
          events: [{ event: { seq: 2, data: { attachment: { attachmentId: `sha256:${digest}` } } } }],
        })
      }
      if (body.method === 'session.history') {
        return rpc({ hasMore: false, events: [{ event: { seq: 0, data: { text: 'first' } } }] })
      }
      if (body.method === 'session.attachment') {
        return rpc({ attachment: { attachmentId: `sha256:${digest}`, mediaType: 'text/plain' }, data: bytes.toString('base64') })
      }
      throw new Error(`unexpected method ${body.method}`)
    },
  })

  const result = await api.logicalExport('s1')

  assert.equal(result.format, 'dsh-logical-session-v1')
  assert.deepEqual(result.events.map(entry => entry.event.seq), [0, 2])
  assert.equal(result.attachments[0].sha256, digest)
  assert.equal(result.attachments[0].bytes, bytes.length)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.authorization === 'Bearer export-token'))
  assert.equal(calls[1].body.payload.beforeSeq, 2)
})
