import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as taskPlugin from '@qingmei/provider-task-sqlite'
import * as taskOrchestrator from '@qingmei/qm-task'
import * as devicePlugin from '../src/index.ts'

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-device-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'device.db') })
  await storeFiber
  await ctx.plugin(gatewayPlugin)
  await ctx.plugin(taskPlugin)
  const pluginFiber = ctx.plugin(devicePlugin, {})
  await pluginFiber
  const orchestratorFiber = ctx.plugin(taskOrchestrator, {})
  await orchestratorFiber
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
      await orchestratorFiber.dispose()
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
      path: '/api/v1/tasks',
      query: {},
      headers: {},
      body: { prompt: '跑测试', title: '测试任务', target: { executorId: 'device:dev_a' } },
    })
    assert.equal(created.status, 202)
    const taskId = created.body.run.id

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
    assert.equal(list.body.items[0].progressHistory.length, 1)
  } finally {
    await h.dispose()
  }
})

test('未知设备拒绝入队', async () => {
  const h = await setup()
  try {
    const res = await h.call({
      method: 'POST',
      path: '/api/v1/tasks',
      query: {},
      headers: {},
      body: { prompt: 'x', target: { executorId: 'device:missing' } },
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

test('设备工作区：上报系统类型、工作区和任务定向', async () => {
  const h = await setup()
  try {
    const reg = await h.call({
      method: 'POST',
      path: '/api/v1/devices/register',
      query: {},
      headers: {},
      body: {
        id: 'dev-workspace',
        platform: 'win32',
        arch: 'x64',
        workspaces: [{ id: 'ws-1', title: 'Workflow', path: 'E:\\Workflow' }],
        harnesses: [{ kind: 'dsh', acp: true }],
      },
    })
    assert.equal(reg.body.device.systemType, 'windows')
    assert.equal(reg.body.device.deviceClass, 'desktop')
    assert.deepEqual(reg.body.device.workspaces, [{ id: 'ws-1', title: 'Workflow', path: 'E:\\Workflow' }])

    const created = await h.call({
      method: 'POST',
      path: '/api/v1/tasks',
      query: {},
      headers: {},
      body: {
        prompt: '只回复 OK',
        target: { executorId: 'device:dev-workspace', workspaceId: 'ws-1' },
      },
    })
    assert.equal(created.status, 202)
    assert.equal(created.body.run.target.workspaceId, 'ws-1')
    assert.equal(created.body.run.target.cwd, 'E:\\Workflow')

    const claimed = await h.call({
      method: 'POST',
      path: '/api/v1/devices/claim',
      query: {},
      headers: {},
      body: { deviceId: 'dev-workspace', harness: 'dsh' },
    })
    assert.equal(claimed.body.task.id, created.body.run.id)
    assert.equal(claimed.body.task.target.cwd, 'E:\\Workflow')
  } finally {
    await h.dispose()
  }
})

test('同一 thread 的第二条任务复用上一条 session', async () => {
  const h = await setup()
  try {
    await h.call({
      method: 'POST',
      path: '/api/v1/devices/register',
      query: {},
      headers: {},
      body: {
        id: 'dev-session',
        platform: 'windows',
        arch: 'x64',
        harnesses: [{ kind: 'dsh', acp: true }],
        workspaces: [{ id: 'ws-session', title: 'WS', path: 'C:/ws' }],
      },
    })
    const first = await h.call({
      method: 'POST',
      path: '/api/v1/tasks',
      query: {},
      headers: {},
      body: { prompt: 'first', target: { executorId: 'device:dev-session', workspaceId: 'ws-session', sessionKey: 'thread-1' } },
    })
    assert.equal(first.status, 202)
    const claimed = await h.call({
      method: 'POST',
      path: '/api/v1/devices/claim',
      query: {},
      headers: {},
      body: { deviceId: 'dev-session', harness: 'dsh' },
    })
    await h.call({
      method: 'POST',
      path: '/api/v1/devices/finish',
      query: {},
      headers: {},
      body: { taskId: claimed.body.task.id, status: 'done', sessionId: 'session-cont' },
    })
    const second = await h.call({
      method: 'POST',
      path: '/api/v1/tasks',
      query: {},
      headers: {},
      body: { prompt: 'second', target: { executorId: 'device:dev-session', workspaceId: 'ws-session', sessionKey: 'thread-1' } },
    })
    assert.equal(second.status, 202)
    assert.equal(second.body.run.sessionId, 'session-cont')
  } finally {
    await h.dispose()
  }
})

test('设备 claim 复用 qm-task 的优先级调度', async () => {
  const h = await setup()
  try {
    await h.call({
      method: 'POST',
      path: '/api/v1/devices/register',
      query: {},
      headers: {},
      body: { id: 'dev-priority', platform: 'windows', harnesses: [{ kind: 'dsh', acp: false }] },
    })
    const low = await h.call({
      method: 'POST',
      path: '/api/v1/tasks',
      query: {},
      headers: {},
      body: { prompt: 'low', priority: 1, target: { executorId: 'device:dev-priority' } },
    })
    const high = await h.call({
      method: 'POST',
      path: '/api/v1/tasks',
      query: {},
      headers: {},
      body: { prompt: 'high', priority: 9, target: { executorId: 'device:dev-priority' } },
    })
    const claimed = await h.call({
      method: 'POST',
      path: '/api/v1/devices/claim',
      query: {},
      headers: {},
      body: { deviceId: 'dev-priority' },
    })
    assert.equal(claimed.body.task.id, high.body.run.id)
    assert.notEqual(claimed.body.task.id, low.body.run.id)
  } finally {
    await h.dispose()
  }
})