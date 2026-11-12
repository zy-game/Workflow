/**
 * @qingmei/qm-conversation-profile —— 群画像与策略（docs/11 的最小版）。
 *
 * 安全默认：未配置的群一律只回一句「权限未配置」，不调模型、不召回记忆。
 * 主人通过 `POST /api/v1/conversations/configure` 打标签后，群进入 configured，
 * 后续回复按标签策略收口（长度/口吻/可见范围），并把群规则注入 prompt。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  GROUP_TAG_POLICIES,
  textOf,
  uid,
  ConversationProfileService,
  type ChannelId,
  type ChannelService,
  type ConversationPolicy,
  type ConversationProfile,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type GroupTag,
  type InboundMessage,
  type Row,
  type StoreService,
} from '@qingmei/core'

export interface ConversationProfileConfig {
  /** 固定话术；docs/11 要求确定性路径，不调模型 */
  pendingReply?: string
  /** 累计多少条群消息后给标签建议，默认 8 */
  suggestAfterMessages?: number
}

export const name = 'qm-conversation-profile'
export const inject = ['store', 'channel', 'gateway']

const COLLECTION = 'qm_conversation_profile'
const TAGS: GroupTag[] = ['work', 'casual', 'family', 'client', 'temp']
const LABELS: Record<GroupTag, string> = {
  work: '工作群',
  casual: '吹水群',
  family: '家人群',
  client: '客户群',
  temp: '临时群',
}

interface HistoryRow extends Row {
  profile_id: string
  tags_json: string
  title: string
  status: string
  at: number
}

interface StatsRow extends Row {
  channel: string
  platform_conversation_id: string
  count: number
  texts_json: string
}

interface SuggestionRow extends Row {
  channel: string
  platform_conversation_id: string
  tag: string
  base: string
  note: string
  evidence: string
  status: string
  created_at: number
}

interface ProfileRow extends Row {
  channel: string
  platform_conversation_id: string
  title: string
  kind: string
  tags_json: string
  status: string
  discovered_at: number
  last_active_at: number | null
}

class SqliteConversationProfile extends ConversationProfileService {
  private readonly collection
  private readonly cache = new Map<string, ConversationProfile>()
  private readonly pendingReply: string
  private readonly channel: ChannelService
  private readonly suggestAfter: number
  private readonly stats
  private readonly suggestions
  private readonly historyRows
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, pendingReply: string, channel: ChannelService, suggestAfter: number) {
    super(ctx)
    this.pendingReply = pendingReply
    this.channel = channel
    this.suggestAfter = Math.max(1, suggestAfter)
    const store = ctx.store
    this.collection = store.collection<ProfileRow>(COLLECTION)
    this.stats = store.collection<StatsRow>('qm_conversation_stats')
    this.suggestions = store.collection<SuggestionRow>('qm_conversation_suggestion')
    this.historyRows = store.collection<HistoryRow>('qm_conversation_profile_history')
  }

  /** 启动时把已有画像读进缓存，让「未配置」判断不必等异步查询 */
  async load(): Promise<void> {
    const rows = await this.collection.find({})
    for (const row of rows) this.cache.set(row.id, toProfile(row))
  }

  getCached(channel: ChannelId, conversationId: string): ConversationProfile | undefined {
    return this.cache.get(keyOf(channel, conversationId))
  }

  async get(channel: ChannelId, conversationId: string): Promise<ConversationProfile | null> {
    const id = keyOf(channel, conversationId)
    const cached = this.cache.get(id)
    if (cached) return cached
    const row = await this.collection.get(id)
    if (!row) return null
    const profile = toProfile(row)
    this.cache.set(id, profile)
    return profile
  }

  async list(): Promise<ConversationProfile[]> {
    const rows = await this.collection.find({})
    return rows.map(toProfile).sort((a, b) => b.discoveredAt.getTime() - a.discoveredAt.getTime())
  }

  async configure(input: {
    channel: ChannelId
    conversationId: string
    tags: GroupTag[]
    title?: string
  }): Promise<ConversationProfile> {
    return this.serialize(() => this.configureInner(input))
  }

  private async configureInner(input: {
    channel: ChannelId
    conversationId: string
    tags: GroupTag[]
    title?: string
  }): Promise<ConversationProfile> {
    return (async () => {
      const tags = [...new Set(input.tags)].filter((tag): tag is GroupTag => TAGS.includes(tag))
      if (tags.length === 0) throw new Error('至少给一个合法标签')
      const id = keyOf(input.channel, input.conversationId)
      const existing = await this.collection.get(id)
      const now = Date.now()
      if (existing) {
        await this.historyRows.insert({
          id: uid('snap'),
          profile_id: id,
          tags_json: (existing as unknown as { tags_json: string }).tags_json,
          title: existing.title,
          status: existing.status,
          at: now,
        })
        const older = (await this.historyRows.find({ where: { profile_id: id } }))
          .sort((a, b) => b.at - a.at)
          .slice(20)
        for (const row of older) await this.historyRows.delete(row.id)
        await this.collection.update(id, {
          tags_json: JSON.stringify(tags),
          status: 'configured',
          ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          last_active_at: now,
        })
      } else {
        await this.collection.insert({
          id,
          channel: input.channel,
          platform_conversation_id: input.conversationId,
          title: input.title?.trim() || input.conversationId,
          kind: 'group',
          tags_json: JSON.stringify(tags),
          status: 'configured',
          discovered_at: now,
          last_active_at: now,
        })
      }
      const row = await this.collection.get(id)
      const profile = toProfile(row!)
      this.cache.set(id, profile)
      return profile
    })()
  }

  /** 把新群登记为 pending；已存在则只更新活跃时间 */
  async discover(channel: ChannelId, conversationId: string, title?: string): Promise<ConversationProfile> {
    return this.serialize(async () => {
      const id = keyOf(channel, conversationId)
      const existing = this.cache.get(id)
      const now = Date.now()
      if (existing) {
        await this.historyRows.insert({
          id: uid('snap'),
          profile_id: id,
          tags_json: (existing as unknown as { tags_json: string }).tags_json,
          title: existing.title,
          status: existing.status,
          at: now,
        })
        const older = (await this.historyRows.find({ where: { profile_id: id } }))
          .sort((a, b) => b.at - a.at)
          .slice(20)
        for (const row of older) await this.historyRows.delete(row.id)
        await this.collection.update(id, { last_active_at: now })
        existing.lastActiveAt = new Date(now)
        return existing
      }
      const row = await this.collection.get(id)
      if (row) {
        const profile = toProfile(row)
        this.cache.set(id, profile)
        return profile
      }
      const inserted = await this.collection.insert({
        id,
        channel,
        platform_conversation_id: conversationId,
        title: title || conversationId,
        kind: 'group',
        tags_json: '[]',
        status: 'pending',
        discovered_at: now,
        last_active_at: now,
      })
      const profile = toProfile(inserted)
      this.cache.set(id, profile)
      return profile
    })
  }

  policyTags(tags: GroupTag[]): ConversationPolicy {
    const policies = tags.map((tag) => GROUP_TAG_POLICIES[tag]).filter(Boolean)
    if (policies.length === 0) return GROUP_TAG_POLICIES.temp
    return {
      audiences: [],
      maxChars: Math.min(...policies.map((policy) => policy.maxChars)),
      tone: policies.some((policy) => policy.tone === 'formal')
        ? 'formal'
        : policies.some((policy) => policy.tone === 'neutral')
          ? 'neutral'
          : 'casual',
      proactive: policies.every((policy) => policy.proactive),
      forbiddenTopics: [...new Set(policies.flatMap((policy) => policy.forbiddenTopics))],
    }
  }

  policy(profile: ConversationProfile): ConversationPolicy {
    return this.policyTags(profile.tags)
  }

  async history(profileId: string): Promise<{ at: Date; tags: GroupTag[]; title: string; status: string }[]> {
    const rows = await this.historyRows.find({ where: { profile_id: profileId } })
    return rows
      .sort((a, b) => b.at - a.at)
      .map((row) => ({
        at: new Date(row.at),
        tags: JSON.parse(row.tags_json) as GroupTag[],
        title: row.title,
        status: row.status,
      }))
  }

  async rollback(profileId: string): Promise<ConversationProfile | null> {
    return this.serialize(async () => {
      const rows = (await this.historyRows.find({ where: { profile_id: profileId } })).sort((a, b) => b.at - a.at)
      const snapshot = rows[0]
      if (!snapshot) return null
      await this.collection.update(profileId, {
        tags_json: snapshot.tags_json,
        title: snapshot.title,
        status: snapshot.status,
        last_active_at: Date.now(),
      })
      await this.historyRows.delete(snapshot.id)
      const row = await this.collection.get(profileId)
      if (!row) return null
      const profile = toProfile(row)
      this.cache.set(profileId, profile)
      return profile
    })
  }

  note(profile: ConversationProfile): string {
    const policy = this.policy(profile)
    const labels = profile.tags.map((tag) => LABELS[tag]).join('、') || '临时群'
    const forbidden = policy.forbiddenTopics.length > 0 ? `；禁止话题：${policy.forbiddenTopics.join('/')}` : ''
    return `本群标签：${labels}；回复不超过 ${policy.maxChars} 字；语气${policy.tone}${policy.proactive ? '' : '；不主动发言'}${forbidden}`
  }

  /** 记录群消息；达到阈值后给一次标签建议（只建议，不自动应用） */
  async recordGroupMessage(channel: ChannelId, conversationId: string, text: string): Promise<void> {
    const trimmed = text.trim().slice(0, 200)
    if (!trimmed) return
    await this.serialize(async () => {
      const id = keyOf(channel, conversationId)
      const existing = await this.stats.get(id)
      const texts = existing ? parseJson<string[]>(existing.texts_json, []) : []
      texts.push(trimmed)
      if (texts.length > 20) texts.shift()
      const count = (existing?.count ?? 0) + 1
      if (existing) await this.stats.update(id, { count, texts_json: JSON.stringify(texts) })
      else {
        await this.stats.insert({
          id,
          channel,
          platform_conversation_id: conversationId,
          count,
          texts_json: JSON.stringify(texts),
        })
      }

      if (count < this.suggestAfter) return
      const rows = await this.suggestions.find({})
      if (rows.some((row) => row.channel === channel && row.platform_conversation_id === conversationId)) return

      const suggestion = classifySuggestion(texts)
      await this.suggestions.insert({
        id: uid('sug'),
        channel,
        platform_conversation_id: conversationId,
        tag: suggestion.tag,
        base: suggestion.tag,
        note: suggestion.note,
        evidence: suggestion.evidence,
        status: 'proposed',
        created_at: Date.now(),
      })
      await this.channel
        .send({
          channel: 'web',
          conversationId: 'owner',
          blocks: [
            {
              type: 'text',
              text: `💡 群 ${conversationId} 可能是${LABELS[suggestion.tag]}（证据：${suggestion.evidence}）。采纳：POST /api/v1/conversations/suggestions/accept`,
            },
          ],
        })
        .catch(() => undefined)
    })
  }

  async listSuggestions(): Promise<{
    id: string
    channel: ChannelId
    conversationId: string
    tag: GroupTag
    note: string
    evidence: string
    createdAt: Date
  }[]> {
    const rows = await this.suggestions.find({})
    return rows
      .filter((row) => row.status === 'proposed')
      .sort((a, b) => b.created_at - a.created_at)
      .map((row) => ({
        id: row.id,
        channel: row.channel as ChannelId,
        conversationId: row.platform_conversation_id,
        tag: row.tag as GroupTag,
        note: row.note,
        evidence: row.evidence,
        createdAt: new Date(row.created_at),
      }))
  }

  async acceptSuggestion(id: string): Promise<ConversationProfile | null> {
    return this.serialize(async () => {
      const suggestion = await this.suggestions.get(id)
      if (!suggestion || suggestion.status !== 'proposed') return null
      const current = await this.get(suggestion.channel as ChannelId, suggestion.platform_conversation_id)
      const tags = [...new Set([...(current?.tags ?? []), suggestion.tag as GroupTag])]
      const profile = await this.configureInner({
        channel: suggestion.channel as ChannelId,
        conversationId: suggestion.platform_conversation_id,
        tags,
        ...(current?.title ? { title: current.title } : {}),
      })
      await this.suggestions.update(id, { status: 'accepted' })
      return profile
    })
  }

  async dismissSuggestion(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const suggestion = await this.suggestions.get(id)
      if (!suggestion || suggestion.status !== 'proposed') return false
      await this.suggestions.update(id, { status: 'dismissed' })
      return true
    })
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

export function apply(ctx: Context, config: ConversationProfileConfig = {}): void {
  const channel = ctx.channel
  const gateway = ctx.gateway
  if (!gateway) throw new Error('[qm-conversation-profile] 缺少 gateway 服务')

  const pendingReply = config.pendingReply ?? '权限未配置'
  const profiles = new SqliteConversationProfile(
    ctx,
    pendingReply,
    channel,
    config.suggestAfterMessages ?? 8,
  )
  void profiles.load().catch(() => undefined)

  ctx.events.on(EVENTS.inbound, (message: InboundMessage) => {
    if (message.conversation.kind !== 'group') return
    void profiles
      .recordGroupMessage(message.channel, message.conversation.id, textOf(message.blocks))
      .catch(() => undefined)
    // 同步判断：缓存在启动时已加载，未配置的群不进入模型
    const cached = profiles.getCached(message.channel, message.conversation.id)
    if (cached && cached.status === 'configured') {
      void profiles.discover(message.channel, message.conversation.id, cached.title).catch(() => undefined)
      return
    }
    if (cached && (cached.status === 'muted' || cached.status === 'blocked')) {
      message.handledBy = 'conversation-profile'
      return
    }
    message.handledBy = 'conversation-profile'
    void profiles
      .discover(message.channel, message.conversation.id)
      .then(async (profile) => {
        await channel.send({
          channel: message.channel,
          conversationId: message.conversation.id,
          blocks: [{ type: 'text', text: pendingReply }],
        })
        // 首次发现才通知 owner（pending 已在缓存里就不重复）
        if (!cached) {
          await channel.send({
            channel: 'web',
            conversationId: 'owner',
            blocks: [
              {
                type: 'text',
                text: `🆕 发现新群：${profile.channel} ${profile.title}（${profile.platformConversationId}），请用 POST /api/v1/conversations/configure 打标签`,
              },
            ],
          })
        }
      })
      .catch(() => undefined)
  })

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/conversations/suggestions',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        res.status(200).send({ ok: true, items: await profiles.listSuggestions() })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/conversations/suggestions/accept',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const profile = await profiles.acceptSuggestion(id)
        if (!profile) {
          res.status(404).send({ ok: false, error: '没有这条建议' })
          return
        }
        res.status(200).send({ ok: true, profile, policy: profiles.policy(profile) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/conversations/suggestions/dismiss',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const ok = await profiles.dismissSuggestion(id)
        res.status(ok ? 200 : 404).send(ok ? { ok: true } : { ok: false, error: '没有这条建议' })
      },
    }),
  )
  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/conversations',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        res.status(200).send({ ok: true, items: await profiles.list() })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/conversations/configure',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const channelId = typeof body.channel === 'string' ? body.channel.trim() : ''
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
        const tags = Array.isArray(body.tags) ? body.tags.map((tag) => String(tag)) : []
        if (!channelId || !conversationId) {
          res.status(400).send({ ok: false, error: 'channel 和 conversationId 必填' })
          return
        }
        const invalid = tags.filter((tag) => !TAGS.includes(tag as GroupTag))
        if (invalid.length > 0) {
          res.status(400).send({ ok: false, error: `未知标签：${invalid.join(', ')}` })
          return
        }
        try {
          const profile = await profiles.configure({
            channel: channelId as ChannelId,
            conversationId,
            tags: tags as GroupTag[],
            ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {}),
          })
          res.status(200).send({ ok: true, profile, policy: profiles.policy(profile) })
        } catch (error) {
          res.status(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/conversations/preview',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const raw = typeof req.query.tags === 'string' ? req.query.tags : ''
        const tags = raw
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag): tag is GroupTag => TAGS.includes(tag as GroupTag))
        res.status(200).send({ ok: true, tags, policy: profiles.policyTags(tags) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/conversations/history',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const channelId = typeof req.query.channel === 'string' ? req.query.channel.trim() : ''
        const conversationId =
          typeof req.query.conversationId === 'string' ? req.query.conversationId.trim() : ''
        if (!channelId || !conversationId) {
          res.status(400).send({ ok: false, error: 'channel 和 conversationId 必填' })
          return
        }
        res.status(200).send({
          ok: true,
          items: await profiles.history(keyOf(channelId as ChannelId, conversationId)),
        })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/conversations/rollback',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const channelId = typeof body.channel === 'string' ? body.channel.trim() : ''
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
        if (!channelId || !conversationId) {
          res.status(400).send({ ok: false, error: 'channel 和 conversationId 必填' })
          return
        }
        const profile = await profiles.rollback(keyOf(channelId as ChannelId, conversationId))
        if (!profile) {
          res.status(404).send({ ok: false, error: '没有可回滚的历史' })
          return
        }
        res.status(200).send({ ok: true, profile, policy: profiles.policy(profile) })
      },
    }),
  )
}

const SUGGEST_KEYWORDS: Record<GroupTag, string[]> = {
  client: ['合同', '报价', '交付', '甲方', '需求'],
  work: ['进度', '项目', '周会', '排期', '上线'],
  family: ['孩子', '家里', '爸妈', '生日'],
  casual: [],
  temp: [],
}

/** 至少命中两个不同关键词才给非吹水标签：只出现一次「项目」的玩笑群不该被贴成工作群 */
const MIN_KEYWORD_HITS = 2

/** 只给建议：按关键词粗分，证据写清楚，最终由 owner 采纳 */
export function classifySuggestion(texts: string[]): { tag: GroupTag; note: string; evidence: string } {
  let best: GroupTag = 'casual'
  let bestHits: string[] = []
  for (const tag of ['client', 'work', 'family'] as GroupTag[]) {
    const hits = SUGGEST_KEYWORDS[tag].filter((keyword) => texts.some((text) => text.includes(keyword)))
    if (hits.length > bestHits.length) {
      best = tag
      bestHits = hits
    }
  }
  if (bestHits.length === 0) {
    return { tag: 'casual', note: '没有明显的工作/客户/家庭关键词，倾向吹水群', evidence: `${texts.length} 条消息，无匹配关键词` }
  }
  if (bestHits.length < MIN_KEYWORD_HITS) {
    return {
      tag: 'casual',
      note: '关键词太少（只命中一个），不足以判断群性质，先按吹水群',
      evidence: `${bestHits.join('、')}（${texts.length} 条消息只命中 1 个关键词）`,
    }
  }
  const count = texts.filter((text) => bestHits.some((keyword) => text.includes(keyword))).length
  return {
    tag: best,
    note: `群消息里出现了${bestHits.join('、')}，建议归为${LABELS[best]}`,
    evidence: `${bestHits.join('、')}（${count}/${texts.length} 条）`,
  }
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
function keyOf(channel: ChannelId, conversationId: string): string {
  return `${channel}:${conversationId}`
}

function toProfile(row: ProfileRow): ConversationProfile {
  return {
    id: row.id,
    channel: row.channel as ChannelId,
    platformConversationId: row.platform_conversation_id,
    title: row.title,
    kind: row.kind === 'dm' ? 'dm' : 'group',
    tags: parseTags(row.tags_json),
    status: ['pending', 'configured', 'muted', 'blocked'].includes(row.status)
      ? (row.status as ConversationProfile['status'])
      : 'pending',
    discoveredAt: new Date(row.discovered_at),
    lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : null,
  }
}

function parseTags(raw: string): GroupTag[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((tag): tag is GroupTag => TAGS.includes(tag as GroupTag))
  } catch {
    return []
  }
}

export const defaultExport = { name, inject, apply }
