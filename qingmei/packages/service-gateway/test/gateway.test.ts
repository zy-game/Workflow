import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import type { GatewayEvent, GatewayRequest, GatewayResponse, RouteDefinition } from '@qingmei/core'
import * as GatewayPlugin from '../src/index.ts'
import type { GatewayHub } from '../src/index.ts'

async function setup(): Promise<{ ctx: Context; gateway: GatewayHub }> {
  const ctx = new Context()
  await ctx.plugin(GatewayPlugin)
  return { ctx, gateway: ctx.gateway as GatewayHub }
}

function fakeResponse(): {
  state: { status: number; headers: Record<string, string>; body: unknown; sent: boolean }
  response: GatewayResponse
} {
  const state = { status: 200, headers: {} as Record<string, string>, body: undefined as unknown, sent: false }
  const response: GatewayResponse = {
    status(code) {
      state.status = code
      return response
    },
    header(name, value) {
      state.headers[name] = value
      return response
    },
    send(body) {
      state.body = body
      state.sent = true
    },
  }
  return { state, response }
}

test('route 注册路由，match 能查到，disposer 撤销后失效', async () => {
  const { gateway } = await setup()
  const def: RouteDefinition = {
    method: 'GET',
    path: '/api/v1/demo',
    handler() {},
  }

  const dispose = gateway.route(def)
  assert.equal(gateway.routeCount, 1)
  assert.equal(gateway.match('GET', '/api/v1/demo'), def)
  assert.equal(gateway.match('get', 'api/v1/demo'), def, '方法大小写与缺少前导 / 都应归一化')

  dispose()
  assert.equal(gateway.routeCount, 0)
  assert.equal(gateway.match('GET', '/api/v1/demo'), undefined)
})

test('同 method+path 覆盖：旧 disposer 不能拆掉后注册的路由', async () => {
  const { gateway } = await setup()
  const calls: string[] = []
  const first: RouteDefinition = {
    method: 'GET',
    path: '/api/v1/demo',
    handler() {
      calls.push('first')
    },
  }
  const second: RouteDefinition = {
    method: 'GET',
    path: '/api/v1/demo',
    handler() {
      calls.push('second')
    },
  }

  const disposeFirst = gateway.route(first)
  const disposeSecond = gateway.route(second)

  assert.equal(gateway.routeCount, 1, '同 key 应覆盖而不是追加')
  assert.equal(gateway.match('GET', '/api/v1/demo'), second)

  disposeFirst()
  assert.equal(gateway.match('GET', '/api/v1/demo'), second, '旧 disposer 必须识别出路由已被覆盖')

  await gateway.dispatch(
    { method: 'GET', path: '/api/v1/demo', query: {}, headers: {}, body: undefined },
    fakeResponse().response,
  )
  assert.deepEqual(calls, ['second'])

  disposeSecond()
  assert.equal(gateway.match('GET', '/api/v1/demo'), undefined)
})

test('publish 广播给所有订阅者，单个 disposer 只摘掉自己', async () => {
  const { gateway } = await setup()
  const seenA: GatewayEvent[] = []
  const seenB: GatewayEvent[] = []
  const disposeA = gateway.subscribe((event) => seenA.push(event))
  const disposeB = gateway.subscribe((event) => seenB.push(event))

  const event: GatewayEvent = { type: 'assistant', data: { text: 'hi' } }
  gateway.publish(event)
  assert.deepEqual(seenA, [event])
  assert.deepEqual(seenB, [event])
  assert.equal(gateway.subscriberCount, 2)

  disposeA()
  assert.equal(gateway.subscriberCount, 1)
  gateway.publish({ type: 'assistant', data: { text: 'again' } })
  assert.equal(seenA.length, 1)
  assert.equal(seenB.length, 2)

  disposeB()
  assert.equal(gateway.subscriberCount, 0)
})

test('一个订阅者抛错不影响其它订阅者收到事件', async () => {
  const { gateway } = await setup()
  const received: GatewayEvent[] = []
  const disposeBad = gateway.subscribe(() => {
    throw new Error('boom')
  })
  const disposeGood = gateway.subscribe((event) => received.push(event))

  gateway.publish({ type: 'tick', data: { n: 1 } })
  assert.equal(received.length, 1)
  assert.deepEqual(received[0], { type: 'tick', data: { n: 1 } })

  disposeBad()
  disposeGood()
})

test('dispatch 调用匹配的 handler，未匹配时返回 false', async () => {
  const { gateway } = await setup()
  const seen: GatewayRequest[] = []
  const dispose = gateway.route({
    method: 'POST',
    path: '/api/v1/echo',
    handler(req, res) {
      seen.push(req)
      res.status(201).header('x-route', 'echo').send({ received: req.body })
    },
  })

  const { state, response } = fakeResponse()
  const request: GatewayRequest = {
    method: 'POST',
    path: '/api/v1/echo',
    query: { a: '1' },
    headers: { 'content-type': 'application/json' },
    body: { hello: 'world' },
  }
  assert.equal(await gateway.dispatch(request, response), true)
  assert.equal(state.status, 201)
  assert.equal(state.headers['x-route'], 'echo')
  assert.deepEqual(state.body, { received: { hello: 'world' } })
  assert.deepEqual(seen, [request])

  assert.equal(
    await gateway.dispatch({ ...request, path: '/api/v1/missing' }, fakeResponse().response),
    false,
  )

  dispose()
  assert.equal(await gateway.dispatch(request, fakeResponse().response), false)
})
