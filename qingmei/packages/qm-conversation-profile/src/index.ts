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
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, pendingReply: string) {
    super(ctx)
    this.pendingReply = pendingReply
    const store = ctx.reflect.get('store', false) as StoreService | undefined
    if (!store) throw new Error('[qm-conversation-profile] 缺少 store 服务')
    this.collection = store.collection<ProfileRow>(COLLECTION)
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
    return this.serialize(async () => {
      const tags = [...new Set(input.tags)].filter((tag): tag is GroupTag => TAGS.includes(tag))
      if (tags.length === 0) throw new Error('至少给一个合法标签')
      const id = keyOf(input.channel, input.conversationId)
      const existing = await this.collection.get(id)
      const now = Date.now()
      if (existing) {
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
    })
  }

  /** 把新群登记为 pending；已存在则只更新活跃时间 */
  async discover(channel: ChannelId, conversationId: string, title?: string): Promise<ConversationProfile> {
    return this.serialize(async () => {
      const id = keyOf(channel, conversationId)
      const existing = this.cache.get(id)
      const now = Date.now()
      if (existing) {
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

  policy(profile: ConversationProfile): ConversationPolicy {
    const policies = profile.tags.map((tag) => GROUP_TAG_POLICIES[tag]).filter(Boolean)
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

  note(profile: ConversationProfile): string {
    const policy = this.policy(profile)
    const labels = profile.tags.map((tag) => LABELS[tag]).join('、') || '临时群'
    const forbidden = policy.forbiddenTopics.length > 0 ? `；禁止话题：${policy.forbiddenTopics.join('/')}` : ''
    return `本群标签：${labels}；回复不超过 ${policy.maxChars} 字；语气${policy.tone}${policy.proactive ? '' : '；不主动发言'}${forbidden}`
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
  const channel = ctx.reflect.get('channel', false) as ChannelService | undefined
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!channel) throw new Error('[qm-conversation-profile] 缺少 channel 服务')
  if (!gateway) throw new Error('[qm-conversation-profile] 缺少 gateway 服务')

  const pendingReply = config.pendingReply ?? '权限未配置'
  const profiles = new SqliteConversationProfile(ctx, pendingReply)
  void profiles.load().catch(() => undefined)

  ctx.events.on(EVENTS.inbound, (message: InboundMessage) => {
    if (message.conversation.kind !== 'group') return
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
