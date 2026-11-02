/**
 * @qingmei/channel-feishu —— 飞书渠道适配器（官方机器人，WebSocket 长连接）。
 *
 * 入站：飞书事件 `im.message.receive_v1` → `qm/inbound`；同一 message_id 去重一次。
 * 出站：`im/v1/messages` 发文本；群聊用 chat_id，私聊用 open_id。
 *
 * 传输层抽成 `FeishuTransport`：真实实现走 `@larksuiteoapi/node-sdk`，
 * 测试注入假实现，不用连飞书也能验证装配与去重。
 * 凭据只从 config 或环境变量读，不落库、不进日志。
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

export const name = 'channel-feishu'
export const inject = ['channel']

export const FEISHU_CHANNEL: ChannelId = 'feishu'

export const capabilities: ChannelCapabilities = {
  markdown: true,
  card: false,
  button: false,
  image: false,
  voice: false,
  file: false,
  edit: false,
  thread: false,
  maxTextLength: 8000,
}

export interface FeishuConfig {
  appId?: string
  appSecret?: string
  /** 出站 receive_id 类型；群聊 chat_id，私聊 open_id */
  receiveIdType?: 'chat_id' | 'open_id' | 'user_id'
  /** 只接受这些会话的消息；空表示全部 */
  allowedChatIds?: string[]
  /** 飞书国际版用 'lark' */
  domain?: 'feishu' | 'lark'
  /** 群聊只在被 @ 时回复，默认 true（与 docs/05 M3 验收一致） */
  requireMentionInGroup?: boolean
}

/** 一条飞书入站消息（传输层归一化后的形状） */
export interface FeishuInboundEvent {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  text: string
  senderId: string
  senderName?: string
  /** 群聊里是否 @ 了机器人 */
  mentioned?: boolean
}

/** 飞书传输层：真实实现用 SDK，测试用假实现 */
export interface FeishuTransport {
  start(onInbound: (event: FeishuInboundEvent) => void): Promise<void>
  sendText(input: { receiveId: string; receiveIdType: string; text: string }): Promise<{ messageId: string }>
  stop(): Promise<void>
}

/** 去重窗口：飞书可能重投同一条事件 */
const SEEN_LIMIT = 500

export function createFeishuAdapter(
  ctx: Context,
  config: FeishuConfig,
  transport: FeishuTransport,
): ChannelAdapter {
  const seen = new Set<string>()
  const receiveIdType = config.receiveIdType ?? 'chat_id'
  const requireMention = config.requireMentionInGroup !== false

  return {
    id: FEISHU_CHANNEL,
    capabilities,
    async start(): Promise<void> {
      await transport.start((event) => {
        if (config.allowedChatIds && config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(event.chatId)) {
          return
        }
        const text = typeof event.text === 'string' ? event.text.trim() : ''
        if (!text) return
        if (event.chatType === 'group' && requireMention && event.mentioned !== true) return
        if (seen.has(event.messageId)) return
        seen.add(event.messageId)
        if (seen.size > SEEN_LIMIT) {
          const oldest = seen.values().next().value
          if (oldest !== undefined) seen.delete(oldest)
        }

        const message: InboundMessage = {
          platformMessageId: event.messageId,
          channel: FEISHU_CHANNEL,
          accountId: config.appId ?? 'feishu',
          conversation: {
            kind: event.chatType === 'p2p' ? 'dm' : 'group',
            id: event.chatId,
          },
          sender: {
            platformUserId: event.senderId,
            displayName: event.senderName ?? event.senderId,
          },
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
      const text = textOf(envelope.blocks)
      if (!text) return { ok: false, error: '空消息不发送' }
      try {
        const result = await transport.sendText({
          receiveId: envelope.conversationId,
          receiveIdType,
          text,
        })
        return { ok: true, ...(result.messageId ? { platformMessageId: result.messageId } : {}) }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },
  }
}

/**
 * 真实传输层：动态 import SDK，避免没装 SDK 时整个组合根起不来。
 * 长连接由 SDK 维护（自动重连），客户端只在 send 时取 tenant token。
 */
export function createLarkTransport(config: FeishuConfig & { appId: string; appSecret: string }): FeishuTransport {
  let inner: FeishuTransport | null = null
  return {
    async start(onInbound) {
      inner = await createRealTransport(config, onInbound)
      await inner.start(onInbound)
    },
    async sendText(input) {
      if (!inner) throw new Error('飞书长连接尚未建立')
      return inner.sendText(input)
    },
    async stop() {
      await inner?.stop()
      inner = null
    },
  }
}

async function createRealTransport(
  config: FeishuConfig & { appId: string; appSecret: string },
  _onInbound: (event: FeishuInboundEvent) => void,
): Promise<FeishuTransport> {
  const lark = (await import('@larksuiteoapi/node-sdk')) as unknown as LarkSdk
  const domain = config.domain === 'lark' ? lark.Domain?.Lark : lark.Domain?.Feishu
  const client = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    ...(domain ? { domain } : {}),
  })

  let handler: ((event: FeishuInboundEvent) => void) | null = null
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': (data: LarkMessageEvent) => {
      const message = data?.message
      if (!message?.message_id || !message.chat_id) return
      const content = parseContent(message.content)
      handler?.({
        messageId: message.message_id,
        chatId: message.chat_id,
        chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
        text: content,
        senderId: data.sender?.sender_id?.open_id ?? '',
        senderName: data.sender?.sender_id?.user_id ?? undefined,
        mentioned: Array.isArray(data.message?.mentions) && data.message.mentions.length > 0,
      })
    },
  })
  const ws = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: 'warn',
    autoReconnect: true,
  })

  return {
    async start(onInbound) {
      handler = onInbound
      await ws.start({ eventDispatcher: dispatcher })
    },
    async sendText({ receiveId, receiveIdType, text }) {
      const response = await client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
      if (response.code !== 0) {
        throw new Error(`feishu send failed ${response.code}: ${response.msg ?? ''}`)
      }
      return { messageId: response.data?.message_id ?? '' }
    },
    async stop() {
      ws.close({ force: true })
    },
  }
}

/** 飞书消息 content 是一段 JSON 字符串：文本消息为 {"text":"..."} */
function parseContent(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  try {
    const parsed = JSON.parse(raw) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    return ''
  }
}

export function apply(ctx: Context, config: FeishuConfig = {}): void {
  const appId = config.appId?.trim() || process.env.QM_FEISHU_APP_ID?.trim() || ''
  const appSecret = config.appSecret?.trim() || process.env.QM_FEISHU_APP_SECRET?.trim() || ''
  if (!appId || !appSecret) {
    ctx.logger.info('[channel-feishu] 未配置 appId/appSecret（或 QM_FEISHU_APP_ID / QM_FEISHU_APP_SECRET），渠道不启用')
    return
  }
  const transport = createLarkTransport({ ...config, appId, appSecret })
  const adapter = createFeishuAdapter(ctx, config, transport)
  const dispose = ctx.channel.register(adapter)
  ctx.effect(() => () => dispose())
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 只给动态 import 用的最小 SDK 形状，避免在类型层引入整个 SDK */
interface LarkSdk {
  Client: new (options: Record<string, unknown>) => {
    im: {
      message: {
        create: (input: {
          params: { receive_id_type: string }
          data: { receive_id: string; msg_type: string; content: string }
        }) => Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>
      }
    }
  }
  EventDispatcher: new (options: Record<string, unknown>) => {
    register: (handlers: Record<string, (data: never) => void>) => unknown
  }
  WSClient: new (options: Record<string, unknown>) => {
    start: (options: { eventDispatcher: unknown }) => Promise<void>
    close: (options?: { force?: boolean }) => void
  }
  Domain?: { Feishu?: string; Lark?: string }
}

interface LarkMessageEvent {
  message?: { message_id?: string; chat_id?: string; chat_type?: string; content?: string; mentions?: unknown[] }
  sender?: { sender_id?: { open_id?: string; user_id?: string } }
}

export const defaultExport = { name, inject, apply }
