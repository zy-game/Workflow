/**
 * @qingmei/channel-qq —— QQ 机器人（官方开放平台）渠道适配器。
 *
 * 走官方机器人协议：AppID + ClientSecret 换 access_token → 拿 WebSocket 网关 →
 * identify 订阅 `GROUP_AND_C2C_EVENT` → 收 `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE`。
 *
 * 会话 id 带上类型前缀（`dm:<openid>` / `group:<group_openid>`）：出站时只剩 conversationId，
 * 必须能区分该发用户接口还是群接口；重启后也不依赖内存映射。
 *
 * 传输层抽成 `QqTransport`，测试注入假实现；真实实现用 Node 原生 WebSocket + fetch，
 * 不引第三方 SDK。凭据只从 config/环境变量读。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  textOf,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelId,
  type ChannelService,
  type InboundMessage,
  type OutboundEnvelope,
  type SendResult,
} from '@qingmei/core'

declare module 'cordis' {
  interface Context {
    channel: ChannelService
  }
}

export const name = 'channel-qq'
export const inject = ['channel']

export const QQ_CHANNEL: ChannelId = 'qq'

export const capabilities: ChannelCapabilities = {
  markdown: false,
  card: false,
  button: false,
  image: false,
  voice: false,
  file: false,
  edit: false,
  thread: false,
  maxTextLength: 2000,
}

export interface QqConfig {
  appId?: string
  clientSecret?: string
  /** 沙箱环境换网关地址（默认正式） */
  sandbox?: boolean
  /** 只接受这些群/用户；空表示全部 */
  allowedConversationIds?: string[]
  /** 测试用：覆盖 API 基址 */
  apiBase?: string
}

export type QqConversationKind = 'dm' | 'group'

/** 归一化后的 QQ 入站消息 */
export interface QqInboundEvent {
  /** 平台消息 id（去重用） */
  messageId: string
  kind: QqConversationKind
  /** 原始 openid / group_openid */
  conversationId: string
  text: string
  senderId: string
}

export interface QqTransport {
  start(onInbound: (event: QqInboundEvent) => void): Promise<void>
  sendMessage(input: {
    kind: QqConversationKind
    conversationId: string
    text: string
    replyTo?: string
  }): Promise<{ messageId?: string }>
  stop(): Promise<void>
}

const SEEN_LIMIT = 500

/** 会话 id 的编码/解码；出站只能拿到 conversationId，所以类型必须进去 */
export function encodeConversationId(kind: QqConversationKind, rawId: string): string {
  return `${kind}:${rawId}`
}

export function decodeConversationId(id: string): { kind: QqConversationKind; rawId: string } | null {
  const index = id.indexOf(':')
  if (index <= 0) return null
  const kind = id.slice(0, index)
  const rawId = id.slice(index + 1)
  if ((kind !== 'dm' && kind !== 'group') || !rawId) return null
  return { kind, rawId }
}

export function createQqAdapter(ctx: Context, config: QqConfig, transport: QqTransport): ChannelAdapter {
  const seen = new Set<string>()
  const allowed = config.allowedConversationIds ?? []

  return {
    id: QQ_CHANNEL,
    capabilities,
    async start(): Promise<void> {
      await transport.start((event) => {
        const text = typeof event.text === 'string' ? stripMentions(event.text) : ''
        if (!text) return
        const conversationId = encodeConversationId(event.kind, event.conversationId)
        if (allowed.length > 0 && !allowed.includes(conversationId) && !allowed.includes(event.conversationId)) {
          return
        }
        if (seen.has(event.messageId)) return
        seen.add(event.messageId)
        if (seen.size > SEEN_LIMIT) {
          const oldest = seen.values().next().value
          if (oldest !== undefined) seen.delete(oldest)
        }

        const message: InboundMessage = {
          platformMessageId: event.messageId,
          channel: QQ_CHANNEL,
          accountId: config.appId ?? 'qq',
          conversation: {
            kind: event.kind === 'dm' ? 'dm' : 'group',
            id: conversationId,
          },
          sender: { platformUserId: event.senderId, displayName: event.senderId },
          blocks: [{ type: 'text', text }],
          receivedAt: new Date(),
        }
        ctx.events.emit(EVENTS.inbound, message)
      })
    },

    async stop(): Promise<void> {
      await transport.stop()
    },

    async send(envelope: OutboundEnvelope): Promise<SendResult> {
      const decoded = decodeConversationId(envelope.conversationId)
      if (!decoded) return { ok: false, error: '无法从 conversationId 判断是私聊还是群聊' }
      const text = textOf(envelope.blocks)
      if (!text) return { ok: false, error: '空消息不发送' }
      try {
        const result = await transport.sendMessage({
          kind: decoded.kind,
          conversationId: decoded.rawId,
          text,
          ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
        })
        return { ok: true, ...(result.messageId ? { platformMessageId: result.messageId } : {}) }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },
  }
}

/** 群消息里 @机器人 会带 `<@!123>` 之类占位符；去掉再当正文 */
export function stripMentions(text: string): string {
  return text.replace(/<@!?\d+>/g, '').trim()
}

/**
 * 真实传输层：Node 原生 WebSocket + fetch。
 * QQ 机器人是长连接协议：hello → identify → 心跳；断线按 op 7 重连。
 */
export function createQqTransport(config: QqConfig & { appId: string; clientSecret: string }): QqTransport {
  let socket: WebSocket | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let sequence: number | null = null
  let handler: ((event: QqInboundEvent) => void) | null = null
  let stopped = false
  let token: { value: string; expiresAt: number } | null = null

  const apiBase = config.apiBase ?? (config.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com')
  const tokenUrl = config.sandbox ? 'https://bots.qq.com/app/getAppAccessToken' : 'https://bots.qq.com/app/getAppAccessToken'

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt - 60_000) return token.value
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: config.appId, clientSecret: config.clientSecret }),
    })
    const body = (await response.json()) as { access_token?: string; expires_in?: number | string; message?: string }
    if (!response.ok || !body.access_token) {
      throw new Error(`QQ access token 获取失败：${body.message ?? response.status}`)
    }
    const expiresIn = Number(body.expires_in ?? 7200)
    token = { value: body.access_token, expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 7200) * 1000 }
    return token.value
  }

  async function connect(): Promise<void> {
    const current = await accessToken()
    const gatewayResponse = await fetch(`${apiBase}/gateway`, {
      headers: { authorization: `QQBot ${current}` },
    })
    const gateway = (await gatewayResponse.json()) as { url?: string; message?: string }
    if (!gateway.url) throw new Error(`QQ 网关获取失败：${gateway.message ?? gatewayResponse.status}`)

    const ws = new WebSocket(gateway.url)
    socket = ws
    ws.addEventListener('message', (event) => {
      void handleFrame(String(event.data))
    })
    ws.addEventListener('close', () => {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      if (!stopped) setTimeout(() => void connect().catch(() => undefined), 3000)
    })
    ws.addEventListener('error', () => {
      // close 事件会随后触发重连
    })
  }

  async function handleFrame(raw: string): Promise<void> {
    let frame: { op?: number; d?: unknown; s?: number | null; t?: string }
    try {
      frame = JSON.parse(raw) as typeof frame
    } catch {
      return
    }
    if (typeof frame.s === 'number') sequence = frame.s

    if (frame.op === 10) {
      const hello = frame.d as { heartbeat_interval?: number }
      const interval = Math.max(5_000, Number(hello?.heartbeat_interval ?? 30_000))
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: 1, d: sequence }))
        }
      }, interval)
      const current = await accessToken()
      socket?.send(
        JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${current}`,
            intents: 1 << 25,
            shard: [0, 1],
            properties: { $os: 'linux', $browser: 'qingmei', $device: 'qingmei' },
          },
        }),
      )
      return
    }

    if (frame.op === 0) {
      const event = parseDispatchEvent(frame.t, frame.d)
      if (event) handler?.(event)
      return
    }

    if (frame.op === 9) {
      // invalid session：重新拿 token 重连
      token = null
      socket?.close()
    }
  }

  return {
    async start(onInbound) {
      handler = onInbound
      stopped = false
      await connect()
    },
    async sendMessage({ kind, conversationId, text, replyTo }) {
      const current = await accessToken()
      const path =
        kind === 'group'
          ? `${apiBase}/v2/groups/${encodeURIComponent(conversationId)}/messages`
          : `${apiBase}/v2/users/${encodeURIComponent(conversationId)}/messages`
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          authorization: `QQBot ${current}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: text, msg_type: 0, ...(replyTo ? { msg_id: replyTo } : {}) }),
      })
      const body = (await response.json()) as { id?: string; message?: string }
      if (!response.ok) throw new Error(`QQ 发送失败：${body.message ?? response.status}`)
      return { messageId: body.id }
    },
    async stop() {
      stopped = true
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      socket?.close()
      socket = null
    },
  }
}

/** 把 op 0 的 dispatch 帧折成入站事件；不认识的事件返回 null */
export function parseDispatchEvent(
  type: string | undefined,
  data: unknown,
): QqInboundEvent | null {
  const payload = data as {
    id?: string
    content?: string
    group_openid?: string
    author?: { user_openid?: string; member_openid?: string; id?: string }
  } | null
  if (!payload?.id) return null
  const text = stripMentions(payload.content ?? '')
  if (!text) return null

  if (type === 'C2C_MESSAGE_CREATE') {
    const openid = payload.author?.user_openid
    if (!openid) return null
    return { messageId: payload.id, kind: 'dm', conversationId: openid, text, senderId: openid }
  }
  if (type === 'GROUP_AT_MESSAGE_CREATE') {
    const groupId = payload.group_openid
    const member = payload.author?.member_openid ?? payload.author?.id ?? ''
    if (!groupId) return null
    return { messageId: payload.id, kind: 'group', conversationId: groupId, text, senderId: member }
  }
  return null
}

export function apply(ctx: Context, config: QqConfig = {}): void {
  const appId = config.appId?.trim() || process.env.QM_QQ_APP_ID?.trim() || ''
  const clientSecret = config.clientSecret?.trim() || process.env.QM_QQ_CLIENT_SECRET?.trim() || ''
  if (!appId || !clientSecret) {
    ctx.logger.info('[channel-qq] 未配置 appId/clientSecret（或 QM_QQ_APP_ID / QM_QQ_CLIENT_SECRET），渠道不启用')
    return
  }
  const transport = createQqTransport({ ...config, appId, clientSecret })
  const adapter = createQqAdapter(ctx, config, transport)
  const dispose = ctx.channel.register(adapter)
  ctx.effect(() => () => dispose())
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const defaultExport = { name, inject, apply }
