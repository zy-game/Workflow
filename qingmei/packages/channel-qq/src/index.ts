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
  markdown: true,
  card: false,
  button: true,
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

export interface QqButton {
  id: string
  label: string
  style?: string
}

/** 用户点击消息按钮（INTERACTION_CREATE, type=11） */
export interface QqCardAction {
  actionId: string
  kind: QqConversationKind
  conversationId: string
  interactionId: string
  actorId?: string
  messageId?: string
}

export interface QqTransport {
  start(
    onInbound: (event: QqInboundEvent) => void,
    onAction?: (action: QqCardAction) => string | void,
  ): Promise<void>
  sendMessage(input: {
    kind: QqConversationKind
    conversationId: string
    text: string
    replyTo?: string
    buttons?: QqButton[]
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
      await transport.start(
        (event) => {
          console.log(`[channel-qq] inbound ${event.kind} conv=${event.conversationId} msg=${event.messageId}`)
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
        },
        (action) => {
          console.log(`[channel-qq] card action ${action.actionId || 'none'}`)
          if (!action.actionId) return '无法识别的操作'
          ctx.events.emit(EVENTS.action, {
            channel: QQ_CHANNEL,
            conversationId: encodeConversationId(action.kind, action.conversationId),
            actionId: action.actionId,
            ...(action.actorId ? { actorId: action.actorId } : {}),
            ...(action.messageId ? { messageId: action.messageId } : {}),
          })
          return '已收到'
        },
      )
    },

    async stop(): Promise<void> {
      await transport.stop()
    },

    async send(envelope: OutboundEnvelope): Promise<SendResult> {
      const decoded = decodeConversationId(envelope.conversationId)
      if (!decoded) return { ok: false, error: '无法从 conversationId 判断是私聊还是群聊' }
      const text = textOf(envelope.blocks)
      if (!text) return { ok: false, error: '空消息不发送' }
      const buttons = buttonsOf(envelope.blocks)
      try {
        const result = await transport.sendMessage({
          kind: decoded.kind,
          conversationId: decoded.rawId,
          text,
          ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
          ...(buttons.length > 0 ? { buttons } : {}),
        })
        return { ok: true, ...(result.messageId ? { platformMessageId: result.messageId } : {}) }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },
  }
}

/** 从 blocks 里取出按钮组（目前只支持一组） */
export function buttonsOf(blocks: OutboundEnvelope['blocks']): QqButton[] {
  for (const block of blocks) {
    if (block.type === 'actions') return block.buttons
  }
  return []
}

/** 群消息里 @机器人 会带 `<@!123>` 之类占位符；去掉再当正文 */
export function stripMentions(text: string): string {
  return text.replace(/<@!?\d+>/g, '').trim()
}

/**
 * 真实传输层：Node 原生 WebSocket + fetch。
 * QQ 机器人是长连接协议：hello → identify → 心跳；断线按 op 7 重连。
 */
export function createQqTransport(config: QqConfig & { appId: string; clientSecret: string }, log?: (line: string) => void): QqTransport {
  let socket: WebSocket | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let sequence: number | null = null
  let handler: ((event: QqInboundEvent) => void) | null = null
  let actionHandler: ((action: QqCardAction) => string | void) | null = null
  let stopped = false
  let token: { value: string; expiresAt: number } | null = null
  /** identify 之后要等 READY 才算真的上线 */
  let readyWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null

  function waitReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        readyWaiter = null
        reject(new Error(`QQ WebSocket 未在 ${timeoutMs}ms 内 READY`))
      }, timeoutMs)
      readyWaiter = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
    })
  }

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
    ws.addEventListener('close', (event) => {
      log?.(`[channel-qq] 连接关闭 code=${event.code}`)
      readyWaiter?.reject(new Error(`QQ WebSocket 连接关闭（${event.code}）`))
      readyWaiter = null
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
            intents: (1 << 25) | (1 << 26),
            shard: [0, 1],
            properties: { $os: 'linux', $browser: 'qingmei', $device: 'qingmei' },
          },
        }),
      )
      return
    }

    if (frame.op === 0) {
      if (frame.t === 'READY') {
        log?.('[channel-qq] 长连接就绪')
        readyWaiter?.resolve()
        readyWaiter = null
        return
      }
      const event = parseDispatchEvent(frame.t, frame.d)
      if (event) {
        handler?.(event)
        return
      }
      const interaction = parseInteractionEvent(frame.d)
      if (interaction) {
        let content = '已收到'
        try {
          const result = actionHandler?.(interaction)
          if (typeof result === 'string' && result) content = result
        } catch {
          content = '处理失败'
        }
        log?.(`[channel-qq] interaction ${interaction.actionId}`)
        await acknowledgeInteraction(interaction.interactionId).catch(() => undefined)
      }
      return
    }

    if (frame.op === 9) {
      // invalid session：重新拿 token 重连
      token = null
      socket?.close()
    }
  }

  /** 回应按钮点击，否则手机端会一直 loading 到超时 */
  async function acknowledgeInteraction(interactionId: string): Promise<void> {
    const current = await accessToken()
    await fetch(`${apiBase}/interactions/${encodeURIComponent(interactionId)}`, {
      method: 'PUT',
      headers: { authorization: `QQBot ${current}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 0 }),
    })
  }

  return {
    async start(onInbound, onAction) {
      handler = onInbound
      actionHandler = onAction ?? null
      stopped = false
      const ready = waitReady(15_000)
      await connect()
      await ready
    },
    async sendMessage({ kind, conversationId, text, replyTo, buttons }) {
      const current = await accessToken()
      const path =
        kind === 'group'
          ? `${apiBase}/v2/groups/${encodeURIComponent(conversationId)}/messages`
          : `${apiBase}/v2/users/${encodeURIComponent(conversationId)}/messages`

      const post = async (body: Record<string, unknown>): Promise<{ id?: string; message?: string }> => {
        const response = await fetch(path, {
          method: 'POST',
          headers: {
            authorization: `QQBot ${current}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        })
        const parsed = (await response.json()) as { id?: string; message?: string }
        if (!response.ok) throw new Error(`QQ 发送失败：${parsed.message ?? response.status}`)
        return parsed
      }

      if (buttons && buttons.length > 0) {
        try {
          const sent = await post({
            content: text,
            msg_type: 2,
            markdown: { content: text },
            keyboard: { content: { rows: [{ buttons: buttons.map(toQqKeyboardButton) }] } },
            ...(replyTo ? { msg_id: replyTo } : {}),
          })
          return { messageId: sent.id }
        } catch (error) {
          // 自定义按钮可能没开通：退回纯文本，审批仍可用文字回复
          log?.(`[channel-qq] 按钮发送失败，退回文本：${messageOf(error)}`)
        }
      }

      const sent = await post({ content: text, msg_type: 0, ...(replyTo ? { msg_id: replyTo } : {}) })
      return { messageId: sent.id }
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

export function toQqKeyboardButton(button: QqButton): Record<string, unknown> {
  return {
    id: button.id,
    render_data: {
      label: button.label,
      visited_label: button.label,
      style: button.style === 'danger' ? 0 : 1,
    },
    action: {
      type: 1,
      permission: { type: 2 },
      data: button.id,
      unsupport_tips: '当前客户端不支持按钮，请回复「批准」或「拒绝」',
    },
  }
}

export function parseInteractionEvent(data: unknown): QqCardAction | null {
  const payload = data as {
    id?: string
    type?: number
    scene?: string
    data?: { resolved?: { button_data?: string; message_id?: string } }
    user_openid?: string
    group_openid?: string
    group_member_openid?: string
  } | null
  if (!payload?.id || payload.type !== 11) return null
  const actionId = payload.data?.resolved?.button_data
  if (!actionId) return null
  const kind: QqConversationKind = payload.scene === 'group' ? 'group' : 'dm'
  const conversationId = kind === 'group' ? payload.group_openid : payload.user_openid
  if (!conversationId) return null
  const actorId = payload.group_member_openid ?? payload.user_openid
  return {
    actionId,
    kind,
    conversationId,
    interactionId: payload.id,
    ...(actorId ? { actorId } : {}),
    ...(payload.data?.resolved?.message_id ? { messageId: payload.data.resolved.message_id } : {}),
  }
}

export function apply(ctx: Context, config: QqConfig = {}): void {
  const appId = config.appId?.trim() || process.env.QM_QQ_APP_ID?.trim() || ''
  const clientSecret = config.clientSecret?.trim() || process.env.QM_QQ_CLIENT_SECRET?.trim() || ''
  if (!appId || !clientSecret) {
    ctx.logger.info('[channel-qq] 未配置 appId/clientSecret（或 QM_QQ_APP_ID / QM_QQ_CLIENT_SECRET），渠道不启用')
    return
  }
  const sandbox = config.sandbox ?? process.env.QM_QQ_SANDBOX === '1'
  const transport = createQqTransport({ ...config, sandbox, appId, clientSecret }, (line) => ctx.logger.info(line))
  const adapter = createQqAdapter(ctx, config, transport)
  const dispose = ctx.channel.register(adapter)
  ctx.effect(() => () => dispose())
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const defaultExport = { name, inject, apply }
