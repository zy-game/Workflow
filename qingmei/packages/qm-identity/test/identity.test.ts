import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as identityPlugin from '../src/index.ts'
import {
  type GatewayRequest,
  type GatewayResponse,
  type IdentityService,
} from '@qingmei/core'

interface FakeResponse {
  res: GatewayResponse
  read(): { status: number; body: unknown }
}

function fakeResponse(): FakeResponse {
  let status = 0
  let body: unknown
  const res: GatewayResponse = {
    status(code) {
      status = code
      return res
    },
    header() {
      return res
    },
    send(value) {
      body = value
      return res
    },
  }
  return { res, read: () => ({ status, body }) }
}

async function setup(config: identityPlugin.IdentityConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-identity-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'identity.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const identityFiber = ctx.plugin(identityPlugin, config)
  await identityFiber
  await new Promise((resolve) => setTimeout(resolve, 20))

  return {
    ctx,
    identity: ctx.reflect.get('identity', false) as IdentityService,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await identityFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(identityPlugin.name, 'qm-identity')
  assert.deepEqual(identityPlugin.inject, ['store', 'gateway'])
})

test('首绑：每渠道第一个私聊绑成 owner，之后陌生账号返回 null', async () => {
  const h = await setup()
  try {
    assert.equal(await h.identity.resolve('feishu', 'u1'), null)

    const first = await h.identity.ensureOwner('feishu', 'u1', '主人')
    assert.equal(first?.id, 'owner')
    assert.equal(first?.role, 'owner')
    assert.equal((await h.identity.resolve('feishu', 'u1'))?.role, 'owner')

    assert.equal(await h.identity.ensureOwner('feishu', 'u2'), null, '同渠道第二个账号不再自动绑')
    assert.equal((await h.identity.ensureOwner('qq', 'q1'))?.id, 'owner', '不同渠道可以各自首绑')
  } finally {
    await h.dispose()
  }
})

test('显式绑定/解绑：其它角色与渠道', async () => {
  const h = await setup()
  try {
    const guest = await h.identity.bind('actor_guest', 'feishu', 'u9', {
      displayName: '访客',
      role: 'guest',
    })
    assert.equal(guest.role, 'guest')
    assert.equal((await h.identity.resolve('feishu', 'u9'))?.id, 'actor_guest')

    const removed = await h.identity.unbind('actor_guest', 'feishu')
    assert.equal(removed, 1)
    assert.equal(await h.identity.resolve('feishu', 'u9'), null)
  } finally {
    await h.dispose()
  }
})

test('API：GET /api/v1/identity、bind、unbind', async () => {
  const h = await setup({ autoBindOwner: false })
  try {
    const bound = await h.call({
      method: 'POST',
      path: '/api/v1/identity/bind',
      query: {},
      headers: {},
      body: { actorId: 'owner', channel: 'feishu', platformUserId: 'u1', role: 'owner' },
    })
    assert.equal(bound.status, 200)

    const listed = await h.call({ method: 'GET', path: '/api/v1/identity', query: {}, headers: {} })
    const body = listed.body as { bindings: { platformUserId: string }[]; owner: { id: string } }
    assert.equal(body.owner.id, 'owner')
    assert.deepEqual(body.bindings.map((item) => item.platformUserId), ['u1'])

    const missing = await h.call({
      method: 'POST',
      path: '/api/v1/identity/bind',
      query: {},
      headers: {},
      body: { actorId: 'owner' },
    })
    assert.equal(missing.status, 400)

    const unbound = await h.call({
      method: 'POST',
      path: '/api/v1/identity/unbind',
      query: {},
      headers: {},
      body: { actorId: 'owner', channel: 'feishu' },
    })
    assert.equal((unbound.body as { removed: number }).removed, 1)
  } finally {
    await h.dispose()
  }
})

test('autoBindOwner=false 时不做首绑', async () => {
  const h = await setup({ autoBindOwner: false })
  try {
    assert.equal(await h.identity.ensureOwner('feishu', 'u1'), null)
  } finally {
    await h.dispose()
  }
})

test('双通道绑定：QQ 发起验证码，飞书确认后两个渠道都绑 owner', async () => {
  const h = await setup({ autoBindOwner: false })
  try {
    const started = await h.call({
      method: 'POST',
      path: '/api/v1/identity/verify/start',
      query: {},
      headers: {},
      body: { channel: 'qq', platformUserId: 'qq-user', displayName: '主人' },
    })
    assert.equal(started.status, 200)
    const code = (started.body as { code: string }).code
    assert.match(code, /^[A-Z0-9]{8}$/)

    const confirmed = await h.call({
      method: 'POST',
      path: '/api/v1/identity/verify/confirm',
      query: {},
      headers: {},
      body: { code, channel: 'feishu', platformUserId: 'fs-user' },
    })
    assert.equal(confirmed.status, 200)
    const listed = await h.identity.list()
    assert.equal(listed.filter((item) => item.actorId === 'owner').length, 2)
    assert.ok(listed.some((item) => item.channel === 'qq' && item.platformUserId === 'qq-user'))
    assert.ok(listed.some((item) => item.channel === 'feishu' && item.platformUserId === 'fs-user'))

    const replay = await h.call({
      method: 'POST',
      path: '/api/v1/identity/verify/confirm',
      query: {},
      headers: {},
      body: { code, channel: 'feishu', platformUserId: 'fs-user' },
    })
    assert.equal(replay.status, 404)
  } finally {
    await h.dispose()
  }
})
