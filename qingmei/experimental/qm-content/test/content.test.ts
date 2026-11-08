import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import { GatewayHub, type GatewayListener } from '@qingmei/service-gateway'
import * as contentPlugin from '../src/index.ts'
import {
  AuditService,
  type AuditEntry,
  type GatewayRequest,
  type GatewayResponse,
} from '@qingmei/core'
import {
  ContentStateError,
  canTransitionItem,
  canTransitionVariant,
  gateStatus,
  renderVariant,
  sharedSentences,
  DEFAULT_GATES,
} from '../src/model.ts'

class FakeAudit extends AuditService {
  readonly entries: AuditEntry[] = []
  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry)
  }
  async query(): Promise<AuditEntry[]> {
    return this.entries
  }
}

function fakeResponse() {
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

function request(method: string, path: string, body?: unknown, query: Record<string, string> = {}): GatewayRequest {
  return { method, path, query, headers: {}, body }
}

async function setup(config: contentPlugin.Config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-content-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'content.db') })
  await storeFiber
  const audit = new FakeAudit(ctx)
  await ctx.plugin(gatewayPlugin)
  const contentFiber = ctx.plugin(contentPlugin, config)
  await contentFiber
  const gateway = ctx.reflect.get('gateway', false) as GatewayHub
  const events: Array<{ type: string; data: unknown }> = []
  const listener: GatewayListener = (event) => events.push(event)
  gateway.subscribe(listener)

  return {
    ctx,
    audit,
    events,
    store: ctx.reflect.get('store', false),
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      gateway.subscribe(listener) // noop：保持接口对称
      await contentFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function apiOf(ctx: Context) {
  return ctx.reflect.get('content', false) as contentPlugin.ContentApi
}

test('插件形态：name / inject 与 docs/18 的出站面一致', () => {
  assert.equal(contentPlugin.name, 'qm-content')
  assert.deepEqual(contentPlugin.inject, ['store', 'gateway', 'audit'])
})

test('创建内容：带正文直接进 drafted，空正文停在 idea', async () => {
  const h = await setup()
  try {
    const api = apiOf(h.ctx)
    const full = await api.create({ title: '一次测试', body: '正文内容', tags: ['青梅'] })
    assert.equal(full.status, 'drafted')
    assert.deepEqual(full.tags, ['青梅'])
    assert.equal(full.source, 'public')

    const idea = await api.create({ title: '只有标题' })
    assert.equal(idea.status, 'idea')

    const list = await api.list()
    assert.equal(list.length, 2)
    assert.equal(h.events.some((event) => event.type === 'content-updated'), true)
  } finally {
    await h.dispose()
  }
})

test('素材分级：work/life 未授权进不了内容库', async () => {
  const h = await setup()
  try {
    const api = apiOf(h.ctx)
    await assert.rejects(() => api.create({ title: '工作细节', source: 'work' }), /逐条授权/)
    const licensed = await api.create({ title: '工作细节', source: 'work', authorized: true })
    assert.equal(licensed.source, 'work')
  } finally {
    await h.dispose()
  }
})

test('状态机：人审链路只走合法迁移，驳回必须带理由', async () => {
  const h = await setup()
  try {
    const api = apiOf(h.ctx)
    const item = await api.create({ title: '待审内容', body: '正文' })
    const reviewing = await api.transition(item.id, 'reviewing')
    assert.equal(reviewing.status, 'reviewing')

    await assert.rejects(() => api.transition(item.id, 'published'), ContentStateError)
    await assert.rejects(() => api.transition(item.id, 'rejected'), /理由/)
    const rejected = await api.transition(item.id, 'rejected', { reason: '口吻不对' })
    assert.equal(rejected.status, 'rejected')
    assert.equal(rejected.rejectReason, '口吻不对')

    const revised = await api.transition(item.id, 'drafting')
    assert.equal(revised.rejectReason, null)

    assert.equal(canTransitionItem('reviewing', 'approved'), true)
    assert.equal(canTransitionItem('approved', 'rejected'), false)
    assert.equal(canTransitionVariant('ready', 'publishing'), false)
  } finally {
    await h.dispose()
  }
})

test('平台形态：微博 ≤140 字、博客保留全文、知乎偏短给提示', () => {
  const item = { title: '标题', body: '第一段讲清楚了这件事的来龙去脉，后面还有更多细节。\n\n第二段是展开。', tags: ['项目', '踩坑'] }
  const weibo = renderVariant(item, 'weibo')
  assert.ok(weibo.body.length <= 140, `微博应 ≤140，实际 ${weibo.body.length}`)
  assert.match(weibo.body, /#项目#/)
  assert.equal(weibo.kind, 'post')

  const blog = renderVariant(item, 'blog')
  assert.equal(blog.body, item.body)

  const zhihu = renderVariant({ ...item, body: '太短' }, 'zhihu')
  assert.equal(zhihu.kind, 'answer')
  assert.ok(zhihu.notes.some((note) => note.includes('偏短')))
})

test('跨平台重复句会被标出来（同一句话不能发两个平台）', () => {
  const sentence = '这次把账号运维拆成内容层与平台层两层来设计'
  const warnings = sharedSentences([
    { platform: 'weibo', body: `${sentence}。` },
    { platform: 'bilibili', body: `${sentence}。` },
    { platform: 'blog', body: '这篇只出现在博客里，长度也够拿来当样本' },
  ])
  assert.equal(warnings.length, 1)
  assert.deepEqual(warnings[0]!.platforms.sort(), ['bilibili', 'weibo'])
})

test('渲染接口：生成四平台形态并落 ready，重复渲染更新同一条', async () => {
  const h = await setup()
  try {
    const created = await h.call(request('POST', '/api/v1/content', { title: '标题', body: '正文', tags: ['a'] }))
    assert.equal(created.status, 201)
    const id = (created.body as { item: { id: string } }).item.id

    const rendered = await h.call(request('POST', '/api/v1/content/render', { id }))
    assert.equal(rendered.status, 200)
    const variants = (rendered.body as { variants: Array<{ platform: string }> }).variants
    assert.deepEqual(variants.map((variant) => variant.platform).sort(), ['bilibili', 'blog', 'weibo', 'zhihu'])

    const again = await h.call(request('POST', '/api/v1/content/render', { id, platforms: ['weibo'] }))
    assert.equal(again.status, 200)
    const detail = await h.call(request('GET', '/api/v1/content/item', undefined, { id }))
    const body = detail.body as { variants: Array<{ platform: string; status: string }> }
    assert.equal(body.variants.filter((variant) => variant.platform === 'weibo').length, 1)
    assert.equal(body.variants.find((variant) => variant.platform === 'weibo')?.status, 'ready')
  } finally {
    await h.dispose()
  }
})

test('发布一律被闸门挡住：未接入平台时如实返回 409，不假装成功', async () => {
  const h = await setup()
  try {
    const api = apiOf(h.ctx)
    const item = await api.create({ title: '待发内容', body: '正文' })
    await api.transition(item.id, 'reviewing')
    await api.transition(item.id, 'approved')

    const attempt = await api.publish(item.id)
    assert.equal(attempt.ok, false)
    assert.equal(attempt.retryable, false)
    assert.match(attempt.reason, /连接器未实现|未接入/)

    const res = await h.call(request('POST', '/api/v1/content/publish', { id: item.id }))
    assert.equal(res.status, 409)
    assert.equal((res.body as { ok: boolean }).ok, false)

    const detail = await api.get(item.id)
    assert.equal(detail?.item.status, 'approved')
    assert.equal(detail?.actions.some((action) => action.action === 'publish' && action.result === 'blocked'), true)
    assert.equal(h.audit.entries.some((entry) => entry.action === 'content.publish' && entry.decision === 'deny'), true)
  } finally {
    await h.dispose()
  }
})

test('闸门状态：预算按今日成功动作计数，静默时段与平台接入一并给出', async () => {
  const h = await setup({ daily: { publish: 1 } })
  try {
    const api = apiOf(h.ctx)
    const store = h.store as { collection: <T>(name: string) => { insert: (value: T) => Promise<T> } }
    await store.collection('qm_content_action').insert({
      id: 'act_seed',
      itemId: 'item_x',
      variantId: null,
      action: 'publish',
      result: 'ok',
      actor: 'owner',
      detail: '测试写入一次成功发布',
      at: new Date().toISOString(),
    } as never)

    const status = await api.status()
    const publish = status.budgets.find((budget) => budget.action === 'publish')!
    assert.equal(publish.used, 1)
    assert.equal(publish.remaining, 0)
    assert.equal(status.platforms.every((platform) => !platform.connected), true)
    assert.equal(status.canPublish, false)

    const quiet = gateStatus(
      { ...DEFAULT_GATES, quietStart: 0, quietEnd: 24 },
      [],
      new Date('2026-11-06T12:00:00'),
    )
    assert.equal(quiet.quiet, true)
    assert.ok(quiet.reasons.some((reason) => reason.includes('静默')))
  } finally {
    await h.dispose()
  }
})

test('接口错误映射：非法迁移 409、缺内容 404、非法输入 400', async () => {
  const h = await setup()
  try {
    const created = await h.call(request('POST', '/api/v1/content', { title: '标题', body: '正文' }))
    const id = (created.body as { item: { id: string } }).item.id

    const conflict = await h.call(request('POST', '/api/v1/content/transition', { id, to: 'published' }))
    assert.equal(conflict.status, 409)

    const missing = await h.call(request('GET', '/api/v1/content/item', undefined, { id: 'nope' }))
    assert.equal(missing.status, 404)

    const invalid = await h.call(request('POST', '/api/v1/content', { title: '' }))
    assert.equal(invalid.status, 400)

    const unlicensed = await h.call(
      request('POST', '/api/v1/content', { title: '工作', source: 'work' }),
    )
    assert.equal(unlicensed.status, 400)
  } finally {
    await h.dispose()
  }
})
