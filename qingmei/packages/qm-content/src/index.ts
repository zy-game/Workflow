/**
 * @qingmei/qm-content —— 内容层账本与 HTTP 面（账号运维 v1 的内容侧）。
 *
 * 三张表：一条内容一个 content_item，一条分发一个 variant，每个执行步骤一条 content_action。
 * 状态机在 model.ts（代码层，A 类）；预算与静默是插件配置（B 类）。
 * 平台连接器不在本包：publish 只做闸门判定并如实返回「未接入」，永不假装成功。
 *
 * 不新增服务契约：内容 API 只供同进程的 MCP 工具与网关路由使用；
 * 平台插件将来各自注册自己的 publish，横切能力复用 permission / audit。
 */
import type { Context } from 'cordis'
import {
  uid,
  type AuditService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type StoreService,
} from '@qingmei/core'
import {
  DEFAULT_GATES,
  EDITABLE_ITEM_STATUSES,
  PLATFORMS,
  assertItemTransition,
  gateStatus,
  hasLiveVariant,
  renderVariant,
  sharedSentences,
  ContentStateError,
  type ContentAction,
  type ContentItem,
  type ContentVariant,
  type GateConfig,
  type GateStatus,
  type ItemStatus,
  type MaterialLevel,
  type Platform,
} from './model.ts'

export * from './model.ts'

export const name = 'qm-content'
export const inject = ['store', 'gateway', 'audit']

export interface Config {
  daily?: Partial<GateConfig['daily']>
  quietStart?: number
  quietEnd?: number
  connected?: Partial<Record<Platform, boolean>>
}

/** 输入不合法；接口层映射成 400 */
export class ContentInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentInputError'
  }
}

/** 找不到内容或平台形态；接口层映射成 404 */
export class ContentNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentNotFoundError'
  }
}

export interface CreateContentInput {
  title: string
  body?: string
  tags?: string[]
  source?: MaterialLevel
  /** work / life 素材必须逐条授权（docs/18 §9.6） */
  authorized?: boolean
}

export interface UpdateContentInput {
  title?: string
  body?: string
  tags?: string[]
  source?: MaterialLevel
  authorized?: boolean
}

export interface ContentDetail {
  item: ContentItem
  variants: ContentVariant[]
  actions: ContentAction[]
}

export interface VariantList {
  variants: ContentVariant[]
  /** 跨平台重复句；同一段话出现在两个平台上就是 bug */
  warnings: Array<{ sentence: string; platforms: string[] }>
}

export interface PublishAttempt {
  ok: false
  reason: string
  retryable: boolean
}

/** 内容层公开面：HTTP 路由与 worker 结果回传共用（结构化鸭子类型） */
export interface ContentApi {
  status(): Promise<GateStatus>
  list(filter?: { status?: ItemStatus; limit?: number }): Promise<ContentItem[]>
  get(id: string): Promise<ContentDetail | null>
  create(input: CreateContentInput, actor?: string): Promise<ContentItem>
  update(id: string, patch: UpdateContentInput, actor?: string): Promise<ContentItem>
  transition(id: string, to: ItemStatus, options?: { reason?: string; actor?: string }): Promise<ContentItem>
  render(id: string, platform: Platform, actor?: string): Promise<ContentVariant>
  variants(id: string): Promise<VariantList>
  publish(id: string, platform?: Platform): Promise<PublishAttempt>
}

const MATERIAL_LEVELS: MaterialLevel[] = ['public', 'work', 'life']

function mergeConfig(config: Config = {}): GateConfig {
  return {
    daily: { ...DEFAULT_GATES.daily, ...(config.daily ?? {}) },
    quietStart: Number.isFinite(config.quietStart) ? Number(config.quietStart) : DEFAULT_GATES.quietStart,
    quietEnd: Number.isFinite(config.quietEnd) ? Number(config.quietEnd) : DEFAULT_GATES.quietEnd,
    connected: { ...DEFAULT_GATES.connected, ...(config.connected ?? {}) },
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function cleanTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title) throw new ContentInputError('标题不能为空')
  if (title.length > 200) throw new ContentInputError('标题不能超过 200 字')
  return title
}

function cleanBody(value: unknown): string {
  const body = typeof value === 'string' ? value.trim() : ''
  if (body.length > 20_000) throw new ContentInputError('正文不能超过 20000 字')
  return body
}

function cleanTags(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ContentInputError('tags 必须是字符串数组')
  const tags = value
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter(Boolean)
  if (tags.length > 10) throw new ContentInputError('标签最多 10 个')
  if (tags.some((tag) => tag.length > 30)) throw new ContentInputError('单个标签不能超过 30 字')
  return [...new Set(tags)]
}

function cleanSource(value: unknown, authorized: unknown): MaterialLevel {
  if (value === undefined) return 'public'
  if (!MATERIAL_LEVELS.includes(value as MaterialLevel)) {
    throw new ContentInputError(`素材分级只能是 ${MATERIAL_LEVELS.join(' / ')}`)
  }
  const source = value as MaterialLevel
  if (source !== 'public' && authorized !== true) {
    throw new ContentInputError('work / life 素材需要先脱敏并逐条授权（authorized: true）')
  }
  return source
}

function assertPlatform(value: unknown): Platform {
  if (!PLATFORMS.includes(value as Platform)) {
    throw new ContentInputError(`平台只能是 ${PLATFORMS.join(' / ')}`)
  }
  return value as Platform
}

function assertStatus(value: unknown): ItemStatus {
  const statuses: ItemStatus[] = [
    'idea',
    'drafting',
    'drafted',
    'reviewing',
    'approved',
    'published',
    'archived',
    'rejected',
  ]
  if (!statuses.includes(value as ItemStatus)) {
    throw new ContentInputError(`状态只能是 ${statuses.join(' / ')}`)
  }
  return value as ItemStatus
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const store = ctx.reflect.get('store', false) as StoreService | undefined
  if (!store) throw new Error('[qm-content] 缺少 store 服务')
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!gateway) throw new Error('[qm-content] 缺少 gateway 服务')
  const audit = ctx.reflect.get('audit', false) as AuditService | undefined
  if (!audit) throw new Error('[qm-content] 缺少 audit 服务')

  const gates = mergeConfig(config)
  const items = store.collection<ContentItem>('qm_content_item')
  const variants = store.collection<ContentVariant>('qm_content_variant')
  const actions = store.collection<ContentAction>('qm_content_action')

  // 索引是可选能力：内存实现不支持时降级为全量扫描，不影响语义
  for (const [collection, fields] of [
    ['qm_content_item', ['status']],
    ['qm_content_variant', ['itemId']],
    ['qm_content_variant', ['platform']],
    ['qm_content_action', ['itemId']],
  ] as const) {
    try {
      await store.ensureIndex(collection, [...fields])
    } catch {
      // 可选能力，缺了也能跑
    }
  }

  async function log(
    itemId: string,
    variantId: string | null,
    action: string,
    result: ContentAction['result'],
    detail: string,
    actor = 'owner',
  ): Promise<void> {
    await actions.insert({
      id: uid('act'),
      itemId,
      variantId,
      action,
      result,
      actor,
      detail,
      at: nowIso(),
    })
  }

  async function auditLog(
    action: string,
    target: string,
    decision: 'allow' | 'deny',
    detail: Record<string, unknown>,
  ): Promise<void> {
    await audit.append({
      at: new Date(),
      actorId: 'owner',
      channel: 'web',
      conversationId: 'content',
      action,
      target,
      decision,
      detail,
      traceId: uid('trace'),
    })
  }

  function emit(id: string, status: ItemStatus): void {
    gateway.publish({ type: 'content-updated', data: { id, status, at: nowIso() } })
  }

  async function requireItem(id: string): Promise<ContentItem> {
    const item = await items.get(id)
    if (!item) throw new ContentNotFoundError(`没有这条内容：${id}`)
    return item
  }

  async function variantsOf(itemId: string): Promise<ContentVariant[]> {
    return variants.find({ where: { itemId }, order: [{ field: 'createdAt', dir: 'asc' }] })
  }

  async function actionsOf(itemId: string): Promise<ContentAction[]> {
    return actions.find({ where: { itemId }, order: [{ field: 'at', dir: 'desc' }], limit: 50 })
  }

  const api: ContentApi = {
    async status() {
      return gateStatus(gates, await actions.find({}))
    },

    async list(filter = {}) {
      const where = filter.status ? { status: filter.status } : {}
      return items.find({ where, order: [{ field: 'updatedAt', dir: 'desc' }], limit: filter.limit ?? 50 })
    },

    async get(id) {
      const item = await items.get(id)
      if (!item) return null
      return { item, variants: await variantsOf(id), actions: await actionsOf(id) }
    },

    async create(input, actor = 'owner') {
      const title = cleanTitle(input.title)
      const body = cleanBody(input.body)
      const tags = cleanTags(input.tags)
      const source = cleanSource(input.source, input.authorized)
      const at = nowIso()
      const status: ItemStatus = body ? 'drafted' : 'idea'
      const item = await items.insert({
        id: uid('item'),
        title,
        body,
        source,
        tags,
        status,
        rejectReason: null,
        createdAt: at,
        updatedAt: at,
      })
      await log(item.id, null, 'create', 'ok', `创建为 ${status}${body ? '（带正文）' : ''}`, actor)
      await auditLog('content.create', item.id, 'allow', { status, source })
      emit(item.id, item.status)
      return item
    },

    async update(id, patch, actor = 'owner') {
      const item = await requireItem(id)
      if (!EDITABLE_ITEM_STATUSES.includes(item.status)) {
        throw new ContentStateError(`内容处于 ${item.status}，已经不能再改草稿`)
      }
      const next: Partial<ContentItem> = {}
      if (patch.title !== undefined) next.title = cleanTitle(patch.title)
      if (patch.body !== undefined) next.body = cleanBody(patch.body)
      if (patch.tags !== undefined) next.tags = cleanTags(patch.tags)
      if (patch.source !== undefined || patch.authorized !== undefined) {
        next.source = cleanSource(patch.source ?? item.source, patch.authorized)
      }
      next.updatedAt = nowIso()
      await items.update(id, next)
      const updated = await requireItem(id)
      await log(id, null, 'update', 'ok', '更新草稿', actor)
      await auditLog('content.update', id, 'allow', { fields: Object.keys(next) })
      emit(id, updated.status)
      return updated
    },

    async transition(id, to, options = {}) {
      const item = await requireItem(id)
      assertItemTransition(item.status, to)
      if (to === 'published' && !hasLiveVariant(await variantsOf(id))) {
        throw new ContentStateError('没有已上线的平台形态，内容不能标记为已发布')
      }
      let rejectReason: string | null = item.rejectReason
      if (to === 'rejected') {
        const reason = typeof options.reason === 'string' ? options.reason.trim() : ''
        if (!reason) throw new ContentInputError('驳回必须带理由')
        rejectReason = reason
      }
      if (to !== 'rejected' && item.status === 'rejected') rejectReason = null
      await items.update(id, { status: to, rejectReason, updatedAt: nowIso() })
      const actor = options.actor ?? 'owner'
      await log(id, null, `transition:${to}`, 'ok', `${item.status} → ${to}${rejectReason ? `（${rejectReason}）` : ''}`, actor)
      await auditLog('content.transition', id, 'allow', { from: item.status, to, reason: rejectReason ?? null })
      emit(id, to)
      return requireItem(id)
    },

    async render(id, platform, actor = 'owner') {
      const item = await requireItem(id)
      if (item.status === 'archived') throw new ContentStateError('已归档的内容不能再生成平台形态')
      const result = renderVariant(item, platform)
      const existing = (await variantsOf(id)).find((variant) => variant.platform === platform)
      const at = nowIso()
      let variant: ContentVariant
      if (existing) {
        if (existing.status === 'live') throw new ContentStateError('已上线的形态不能再覆盖')
        await variants.update(existing.id, {
          kind: result.kind,
          title: result.title,
          body: result.body,
          notes: result.notes,
          status: 'ready',
          error: null,
          updatedAt: at,
        })
        variant = { ...existing, ...result, status: 'ready', error: null, updatedAt: at }
        await log(id, existing.id, 'render', 'ok', `重新生成 ${platform}：${result.notes.join('；') || '无提示'}`, actor)
      } else {
        variant = await variants.insert({
          id: uid('var'),
          itemId: id,
          platform,
          kind: result.kind,
          title: result.title,
          body: result.body,
          notes: result.notes,
          status: 'ready',
          error: null,
          createdAt: at,
          updatedAt: at,
        })
        await log(id, variant.id, 'render', 'ok', `生成 ${platform}：${result.notes.join('；') || '无提示'}`, actor)
      }
      await auditLog('content.render', id, 'allow', { platform, notes: result.notes })
      emit(id, item.status)
      return variant
    },

    async variants(id) {
      await requireItem(id)
      const list = await variantsOf(id)
      return {
        variants: list,
        warnings: sharedSentences(list.map((variant) => ({ platform: variant.platform, body: variant.body }))),
      }
    },

    async publish(id, platform) {
      const item = await requireItem(id)
      const gate = gateStatus(gates, await actions.find({}))
      const reasons: string[] = []
      if (item.status !== 'approved' && item.status !== 'published') {
        reasons.push('内容还没通过人审（approved）')
      }
      const connected = PLATFORMS.map((name) => ({
        platform: name,
        connected: gates.connected[name],
      })).filter((entry) => entry.connected)
      if (platform && !gates.connected[platform]) reasons.push(`${platform} 账号未接入`)
      if (connected.length === 0) reasons.push('平台连接器未实现；账号接入后才会开放发布')
      reasons.push(...gate.reasons)
      const reason = [...new Set(reasons)].join('；')
      await log(id, null, 'publish', 'blocked', reason)
      await auditLog('content.publish', id, 'deny', { platform: platform ?? null, reason })
      emit(id, item.status)
      return { ok: false, reason, retryable: false }
    },
  }

  ctx.effect(() => ctx.provide('content', api))

  function fail(res: GatewayResponse, error: unknown): void {
    if (error instanceof ContentStateError) {
      res.status(409).send({ ok: false, error: error.message })
      return
    }
    if (error instanceof ContentNotFoundError) {
      res.status(404).send({ ok: false, error: error.message })
      return
    }
    if (error instanceof ContentInputError) {
      res.status(400).send({ ok: false, error: error.message })
      return
    }
    ctx.logger.warn(`[qm-content] 未处理的错误：${error instanceof Error ? error.message : String(error)}`)
    res.status(500).send({ ok: false, error: '内容服务内部错误' })
  }

  function post(path: string, handler: (body: Record<string, unknown>, res: GatewayResponse) => Promise<void>): void {
    ctx.effect(() =>
      gateway.route({
        method: 'POST',
        path,
        async handler(req: GatewayRequest, res: GatewayResponse) {
          const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
          try {
            await handler(body, res)
          } catch (error) {
            fail(res, error)
          }
        },
      }),
    )
  }

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/content',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        try {
          const status = req.query.status ? assertStatus(req.query.status) : undefined
          const limit = Number(req.query.limit)
          const list = await api.list({
            ...(status ? { status } : {}),
            ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 200) } : {}),
          })
          res.status(200).send({ ok: true, items: list })
        } catch (error) {
          fail(res, error)
        }
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/content/item',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        try {
          const id = (req.query.id ?? '').trim()
          if (!id) throw new ContentInputError('id 不能为空')
          const detail = await api.get(id)
          if (!detail) throw new ContentNotFoundError(`没有这条内容：${id}`)
          res.status(200).send({ ok: true, ...detail })
        } catch (error) {
          fail(res, error)
        }
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/content/status',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        try {
          res.status(200).send({ ok: true, ...(await api.status()) })
        } catch (error) {
          fail(res, error)
        }
      },
    }),
  )

  post('/api/v1/content', async (body, res) => {
    const item = await api.create({
      title: body.title as string,
      ...(body.body !== undefined ? { body: body.body as string } : {}),
      ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
      ...(body.source !== undefined ? { source: body.source as MaterialLevel } : {}),
      ...(body.authorized !== undefined ? { authorized: body.authorized as boolean } : {}),
    })
    res.status(201).send({ ok: true, item })
  })

  post('/api/v1/content/update', async (body, res) => {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) throw new ContentInputError('id 不能为空')
    const item = await api.update(id, {
      ...(body.title !== undefined ? { title: body.title as string } : {}),
      ...(body.body !== undefined ? { body: body.body as string } : {}),
      ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
      ...(body.source !== undefined ? { source: body.source as MaterialLevel } : {}),
      ...(body.authorized !== undefined ? { authorized: body.authorized as boolean } : {}),
    })
    res.status(200).send({ ok: true, item })
  })

  post('/api/v1/content/transition', async (body, res) => {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) throw new ContentInputError('id 不能为空')
    const to = assertStatus(body.to)
    const item = await api.transition(id, to, {
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    })
    res.status(200).send({ ok: true, item })
  })

  post('/api/v1/content/render', async (body, res) => {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) throw new ContentInputError('id 不能为空')
    const platforms =
      body.platforms === undefined
        ? [...PLATFORMS]
        : Array.isArray(body.platforms)
          ? body.platforms.map(assertPlatform)
          : [assertPlatform(body.platforms)]
    const rendered: ContentVariant[] = []
    for (const platform of platforms) {
      rendered.push(await api.render(id, platform))
    }
    const detail = await api.get(id)
    res.status(200).send({ ok: true, variants: rendered, item: detail?.item })
  })

  post('/api/v1/content/publish', async (body, res) => {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) throw new ContentInputError('id 不能为空')
    const platform = body.platform === undefined ? undefined : assertPlatform(body.platform)
    const attempt = await api.publish(id, platform)
    res.status(409).send({ ok: false, error: attempt.reason, retryable: false })
  })
}

export const defaultExport = { name, inject, apply }
