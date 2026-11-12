/**
 * qm-evolve：成功任务生成技能草稿，采纳才 install，拒绝则不动技能。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as evolvePlugin from '../src/index.ts'
import { EVENTS, SkillService, type GatewayRequest, type GatewayResponse, type TaskRun } from '@qingmei/core'

class FakeSkills extends SkillService {
  readonly installed: { name: string; body: string; description?: string }[] = []
  async install(input: { name: string; body: string; description?: string }): Promise<{ name: string }> {
    this.installed.push(input)
    return { name: input.name }
  }
  async list(): Promise<never[]> {
    return []
  }
  async read(): Promise<null> {
    return null
  }
  async reload(): Promise<never[]> {
    return []
  }
}

function response(): { res: GatewayResponse; read: () => { status: number; body: any } } {
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
    send(payload) {
      body = payload
    },
  }
  return { res, read: () => ({ status, body }) }
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-evolve-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'evolve.db') })
  await storeFiber
  const gatewayFiber = ctx.plugin(gatewayPlugin)
  await gatewayFiber
  const skills = new FakeSkills(ctx)
  const evolveFiber = ctx.plugin(evolvePlugin, {})
  await evolveFiber
  const call = async (method: string, path: string, body?: unknown, query: Record<string, string> = {}) => {
    const r = response()
    await ctx.gateway.dispatch({ method, path, query, headers: {}, body } as GatewayRequest, r.res)
    return r.read()
  }
  const finished = (run: Partial<TaskRun>) => {
    const value = {
      id: 'run_evolve_test_1',
      title: '部署青梅到服务器',
      kind: 'task',
      status: 'done',
      prompt: '打包并部署',
      result: '部署完成，healthz 200，三渠道在线',
      artifacts: [],
      createdAt: new Date(),
      ...run,
    } as TaskRun
    ctx.events.emit(EVENTS.taskFinished, value)
    return value
  }
  return { ctx, skills, call, finished, async dispose() {
    await evolveFiber.dispose()
    await storeFiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  } }
}

async function waitFor<T>(fn: () => Promise<T | null>, label: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${label}`)
}

test('成功任务生成技能草稿，采纳后调用 skills.install', async () => {
  const h = await boot()
  try {
    h.finished({})
    const item = await waitFor(async () => (await h.call('GET', '/api/v1/skills/drafts')).body.items?.[0], '草稿')
    assert.equal(item.status, 'proposed')
    assert.match(item.name, /^task-/)
    assert.match(item.body, /部署完成/)
    assert.equal(h.skills.installed.length, 0, '没采纳之前不能安装')

    const installed = await h.call('POST', '/api/v1/skills/drafts/install', { id: item.id })
    assert.equal(installed.status, 200)
    assert.equal(h.skills.installed.length, 1)
    assert.equal(h.skills.installed[0]!.name, item.name)
  } finally {
    await h.dispose()
  }
})

test('失败任务不生成草稿；拒绝后不能安装', async () => {
  const h = await boot()
  try {
    h.finished({ id: 'run_failed', status: 'failed', result: '失败' })
    const empty = await h.call('GET', '/api/v1/skills/drafts')
    assert.equal(empty.body.items.length, 0)

    h.finished({ id: 'run_reject', title: '另一个成功任务' })
    const item = await waitFor(async () => (await h.call('GET', '/api/v1/skills/drafts')).body.items?.[0], '草稿')
    const rejected = await h.call('POST', '/api/v1/skills/drafts/reject', { id: item.id })
    assert.equal(rejected.status, 200)
    const again = await h.call('POST', '/api/v1/skills/drafts/install', { id: item.id })
    assert.equal(again.status, 409)
    assert.equal(h.skills.installed.length, 0)
  } finally {
    await h.dispose()
  }
})

test('同一任务重复收尾不会重复生成草稿', async () => {
  const h = await boot()
  try {
    h.finished({ id: 'run_same' })
    await waitFor(async () => (await h.call('GET', '/api/v1/skills/drafts')).body.items?.[0], '第一条')
    h.finished({ id: 'run_same' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    const list = await h.call('GET', '/api/v1/skills/drafts')
    assert.equal(list.body.items.length, 1)
  } finally {
    await h.dispose()
  }
})
