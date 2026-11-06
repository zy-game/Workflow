import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as devicePlugin from '../src/index.ts'

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-device-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'device.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  const pluginFiber = ctx.plugin(devicePlugin, {})
  await pluginFiber
  return {
    ctx,
    async call(req) {
      let status = 0
      let body
      const res = {
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
      const handled = await ctx.gateway.dispatch(req, res)
      return { handled, status, body }
    },
    async dispose() {
      await pluginFiber.dispose()
      await storeFiber.dispose()
    },
  }
}

test('设备注册：平台归一化并记录 ACP/MCP 能力', async () => {
  const h = await setup()
  try {
    const reg = await h.call({
      method: 'POST',
      path: '/api/v1/devices/register',
      query: {},
      headers: {},
      body: {
        name: '我的 Windows',
        platform: 'win32',
        arch: 'x64',
        harnesses: [{ kind: 'dsh', acp: true, mcp: true, version: '1.0' }],
      },
    })
    assert.equal(reg.status, 200)
    const device = reg.body.device
    assert.equal(device.platform, 'windows')
    assert.equal(device.harnesses[0].kind, 'dsh')
    assert.equal(device.online, true)

    const list = await h.call({ method: 'GET', path: '/api/v1/devices', query: {}, headers: {} })
    assert.equal(list.body.items.length, 1)
  } finally {
    await h.dispose()
  }
})

test('任务：入队、领取、进度、完成', async () => {
  const h = await setup()
  try {
    const reg = await h.call({
      method: 'POST',
      path: '/api/v1/devices/register',
      query: {},
      headers: {},
      body: { id: 'dev_a', platform: 'windows', harnesses: [{ kind: 'dsh', acp: true }] },
    })
    assert.equal(reg.body.device.id, 'dev_a')

    const created = await h.call({
      method: 'POST',
      path: '/api/v1/devices/tasks',
      query: {},
      headers: {},
      body: { deviceId: 'dev_a', prompt: '跑测试', title: '测试任务', harness: 'dsh' },
    })
    assert.equal(created.status, 201)
    const taskId = created.body.task.id

    const claim = await h.call({
      method: 'POST',
      path: '/api/v1/devices/claim',
      query: {},
      headers: {},
      body: { deviceId: 'dev_a' },
    })
    assert.equal(claim.body.task.id, taskId)
    assert.equal(claim.body.task.status, 'running')

    const progress = await h.call({
      method: 'POST',
      path: '/api/v1/devices/progress',
      query: {},
      headers: {},
      body: { taskId, phase: 'running', percent: 50, note: '一半' },
    })
    assert.equal(progress.status, 200)

    const finish = await h.call({
      method: 'POST',
      path: '/api/v1/devices/finish',
      query: {},
      headers: {},
      body: { taskId, status: 'done', result: '通过' },
    })
    assert.equal(finish.status, 200)

    const list = await h.call({
      method: 'GET',
      path: '/api/v1/devices/tasks',
      query: { deviceId: 'dev_a' },
      headers: {},
    })
    assert.equal(list.body.items[0].status, 'done')
    assert.equal(list.body.items[0].result, '通过')
    assert.equal(list.body.items[0].progress.length, 1)
  } finally {
    await h.dispose()
  }
})

test('未知设备拒绝入队', async () => {
  const h = await setup()
  try {
    const res = await h.call({
      method: 'POST',
      path: '/api/v1/devices/tasks',
      query: {},
      headers: {},
      body: { deviceId: 'missing', prompt: 'x' },
    })
    assert.equal(res.status, 400)
  } finally {
    await h.dispose()
  }
})

test('会话提炼落盘：同一 device/session 幂等', async () => {
  const h = await setup()
  try {
    await h.call({
      method: 'POST',
      path: '/api/v1/devices/register',
      query: {},
      headers: {},
      body: { id: 'dev_i', platform: 'windows', harnesses: [{ kind: 'dsh', acp: true }] },
    })
    const first = await h.call({
      method: 'POST',
      path: '/api/v1/devices/ingest',
      query: {},
      headers: {},
      body: { deviceId: 'dev_i', sessionId: 's1', summary: '完成', turns: [{ role: 'user', text: 'x' }], facts: [], lessons: [] },
    })
    assert.equal(first.status, 200)
    const again = await h.call({
      method: 'POST',
      path: '/api/v1/devices/ingest',
      query: {},
      headers: {},
      body: { deviceId: 'dev_i', sessionId: 's1', summary: '更新', turns: [], facts: [], lessons: [] },
    })
    assert.equal(again.status, 200)
  } finally {
    await h.dispose()
  }
})
