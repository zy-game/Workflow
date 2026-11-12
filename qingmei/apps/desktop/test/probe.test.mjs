/**
 * 连接探测的测试：服务活着但令牌错、服务挂了、全部正常。
 * 「测试连接」如果只测 /healthz，用户会带着错令牌进入正式界面。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { probeServer, describeProbe } = require('../electron/probe.cjs')

function fakeFetch(routes) {
  return async (url) => {
    const path = new URL(url).pathname
    const handler = routes[path]
    if (!handler) return { ok: false, status: 404, json: async () => ({}) }
    const result = typeof handler === 'function' ? handler() : handler
    if (result instanceof Error) throw result
    return result
  }
}

const healthy = { ok: true, status: 200, json: async () => ({ ok: true, channels: [{ id: 'web', online: true }], agent: 3, uptime: 100 }) }

test('probeServer：健康 + 令牌有效', async () => {
  const result = await probeServer({
    serverUrl: 'https://example.test/',
    token: 'good',
    fetchImpl: fakeFetch({ '/healthz': healthy, '/api/v1/session': { ok: true, status: 200, json: async () => ({}) } }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.tokenValid, true)
  assert.deepEqual(result.channels, [{ id: 'web', online: true }])
  assert.equal(describeProbe(result), '连接正常：web 在线')
})

test('probeServer：服务活着但令牌错', async () => {
  const result = await probeServer({
    serverUrl: 'https://example.test',
    token: 'bad',
    fetchImpl: fakeFetch({ '/healthz': healthy, '/api/v1/session': { ok: false, status: 401, json: async () => ({}) } }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.tokenValid, false)
  assert.match(describeProbe(result), /令牌不对/)
})

test('probeServer：连不上时给出可读原因', async () => {
  const result = await probeServer({
    serverUrl: 'https://example.test',
    token: 'x',
    fetchImpl: fakeFetch({ '/healthz': () => new Error('ECONNREFUSED') }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /连不上服务器/)
  assert.match(describeProbe(result), /连不上/)
})

test('probeServer：地址不合法直接拒绝，不发请求', async () => {
  const result = await probeServer({ serverUrl: 'file:///x', token: 'x', fetchImpl: () => { throw new Error('不该被调用') } })
  assert.equal(result.ok, false)
  assert.match(result.error, /http\(s\) URL/)
})

test('probeServer：服务在线但没有渠道在线时要说清楚', () => {
  assert.match(
    describeProbe({ ok: true, tokenValid: true, channels: [{ id: 'web', online: false }] }),
    /没有任何渠道在线/,
  )
})
