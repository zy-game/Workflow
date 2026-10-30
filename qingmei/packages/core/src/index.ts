/**
 * @qingmei/core —— P1 契约层。
 *
 * 这里只放：协议类型、事件名、服务的抽象类。
 * 不放任何实现，也不认识任何具体渠道/模型/存储。
 */
import { Service, type Context } from 'cordis'

// ────────────────────────────────────────────── 基础类型

export type ChannelId = 'qq' | 'feishu' | 'web' | 'watch'

export type Block =
  | { type: 'text'; text: string }
  | { type: 'markdown'; text: string }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'file'; url: string; name: string }
  | { type: 'voice'; url: string; durationMs?: number }
  | { type: 'card'; title?: string; fields: { label: string; value: string }[] }
  | { type: 'actions'; buttons: { id: string; label: string; style?: 'primary' | 'danger' }[] }
  | { type: 'quote'; messageId: string; text: string }

export interface Conversation {
  kind: 'dm' | 'group' | 'thread'
  id: string
  title?: string
}

export interface InboundMessage {
  /** 平台消息 id，用于幂等 */
  platformMessageId: string
  channel: ChannelId
  accountId: string
  conversation: Conversation
  sender: { platformUserId: string; displayName: string }
  blocks: Block[]
  replyTo?: string
  receivedAt: Date
}

export interface OutboundEnvelope {
  channel: ChannelId
  conversationId: string
  blocks: Block[]
  editTarget?: string
  replyTo?: string
  idempotencyKey?: string
}

export interface SendResult {
  ok: boolean
  platformMessageId?: string
  error?: string
}

export interface ChannelCapabilities {
  markdown: boolean
  card: boolean
  button: boolean
  image: boolean
  voice: boolean
  file: boolean
  edit: boolean
  thread: boolean
  maxTextLength: number
}

export interface ChannelAdapter {
  id: ChannelId
  capabilities: ChannelCapabilities
  start(): Promise<void>
  stop(): Promise<void>
  send(envelope: OutboundEnvelope): Promise<SendResult>
}

// ────────────────────────────────────────────── 事件

export const EVENTS = {
  inbound: 'qm/inbound',
  turnRequest: 'qm/turn/request',
  turnChunk: 'qm/turn/chunk',
  turnEnd: 'qm/turn/end',
  channelOnline: 'qm/channel/online',
  channelOffline: 'qm/channel/offline',
} as const

export interface TurnRequest {
  sessionId: string
  inbound: InboundMessage
  history: ChatMessage[]
}

export interface TurnChunk {
  sessionId: string
  text: string
}

export interface TurnEnd {
  sessionId: string
  ok: boolean
  text: string
  error?: string
}

// ────────────────────────────────────────────── 存储

export interface Row {
  id: string
}

export interface Query<T> {
  where?: Partial<T>
  order?: { field: keyof T; dir: 'asc' | 'desc' }[]
  limit?: number
  offset?: number
}

export interface Collection<T extends Row> {
  get(id: string): Promise<T | null>
  find(query?: Query<T>): Promise<T[]>
  insert(value: Omit<T, 'id'> & { id?: string }): Promise<T>
  update(id: string, patch: Partial<T>): Promise<void>
  delete(id: string): Promise<boolean>
  count(query?: Query<T>): Promise<number>
}

export interface Migration {
  id: string
  sql: string
}

export abstract class StoreService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'store')
  }
  abstract ready(): Promise<void>
  abstract collection<T extends Row>(name: string): Collection<T>
  /** 把多次写入合成一次提交；期间抛错整体回滚 */
  abstract transaction<T>(fn: () => Promise<T> | T): Promise<T>
  /** 按顺序应用未执行过的迁移，返回本次实际执行的 id */
  abstract migrate(migrations: Migration[]): Promise<string[]>
}

// ────────────────────────────────────────────── 渠道

export abstract class ChannelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'channel')
  }
  abstract register(adapter: ChannelAdapter): () => void
  abstract send(envelope: OutboundEnvelope): Promise<SendResult>
  abstract status(): { id: ChannelId; online: boolean }[]
}

// ────────────────────────────────────────────── 网关

export interface GatewayRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

export interface GatewayResponse {
  status(code: number): GatewayResponse
  header(name: string, value: string): GatewayResponse
  send(body: string | Uint8Array | object): void
  sse?(): { write(event: string, data: unknown): void; close(): void }
}

export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  handler(req: GatewayRequest, res: GatewayResponse): Promise<void> | void
}

export interface GatewayEvent {
  type: string
  data: unknown
}

export abstract class GatewayService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'gateway')
  }
  abstract route(def: RouteDefinition): () => void
  abstract publish(event: GatewayEvent): void
}

// ────────────────────────────────────────────── 模型

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ChatStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'done' }

export interface ChatRequest {
  messages: ChatMessage[]
  signal?: AbortSignal
}

export abstract class LlmService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  abstract complete(req: ChatRequest): Promise<{ text: string }>
  abstract chat(req: ChatRequest): AsyncIterable<ChatStreamChunk>
}

// ────────────────────────────────────────────── Harness（内嵌 agent runtime）

export interface HarnessRequest {
  /** 会话键：同一会话复用同一个外部 agent 会话 */
  conversationId: string
  text: string
  cwd?: string
  signal?: AbortSignal
}

export type HarnessEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; status: string }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string }

/**
 * 外部 agent runtime（DSH / ZCode…）的抽象。
 *
 * 与 LlmService 的分界：llm 只产出文本；harness 拥有自己的会话、工具与上下文压缩。
 * 对话车道用 harness，后台结构化任务（抽取/分类）仍用 llm。
 */
export abstract class HarnessService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'harness')
  }
  /** 能否在当前环境拉起并握手；false 时调用方应降级到 llm */
  abstract available(): Promise<boolean>
  /** 跑一轮对话；按事件流返回，结束时必然发出 done 或 error */
  abstract run(req: HarnessRequest): AsyncIterable<HarnessEvent>
  /** 关闭某个会话的外部资源 */
  abstract close(conversationId: string): Promise<void>
}

// ────────────────────────────────────────────── 工具函数

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** 单调、无依赖的短 id（时间前缀 + 随机后缀），足够 P1 用 */
export function uid(prefix: string): string {
  const now = Date.now().toString(36).padStart(9, '0')
  let rnd = ''
  for (let i = 0; i < 6; i++) rnd += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return `${prefix}_${now}${rnd}`
}

/** 把 Block[] 拍平成纯文本，用于日志、兜底与不支持富文本的渠道 */
export function textOf(blocks: Block[]): string {
  const out: string[] = []
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
      case 'markdown':
        out.push(b.text)
        break
      case 'image':
        out.push(`[图片]${b.alt ? ' ' + b.alt : ''}`)
        break
      case 'file':
        out.push(`[文件] ${b.name}`)
        break
      case 'voice':
        out.push('[语音]')
        break
      case 'card':
        out.push([b.title ?? '', ...b.fields.map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join('\n'))
        break
      case 'actions':
        out.push(b.buttons.map((x, i) => `${i + 1}. ${x.label}`).join('\n'))
        break
      case 'quote':
        out.push(`> ${b.text}`)
        break
    }
  }
  return out.join('\n')
}

/** 每个渠道的降级能力矩阵，渠道插件应以此为准做裁剪 */
export function clampToCapabilities(blocks: Block[], caps: ChannelCapabilities): Block[] {
  return blocks
    .map((b) => {
      if (b.type === 'markdown' && !caps.markdown) return { type: 'text' as const, text: b.text }
      if (b.type === 'card' && !caps.card) {
        return {
          type: 'text' as const,
          text: [b.title ?? '', ...b.fields.map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join('\n'),
        }
      }
      if (b.type === 'actions' && !caps.button) {
        return {
          type: 'text' as const,
          text: b.buttons.map((x, i) => `${i + 1}. ${x.label}`).join('\n'),
        }
      }
      return b
    })
    .flatMap((b) => {
      if (b.type === 'text' && b.text.length > caps.maxTextLength) {
        const chunkSize = Math.max(1, caps.maxTextLength)
        const chunks: Block[] = []
        for (let i = 0; i < b.text.length; i += chunkSize) {
          chunks.push({ type: 'text', text: b.text.slice(i, i + chunkSize) })
        }
        return chunks
      }
      return [b]
    })
}

/** 服务名常量，避免各处手写字符串拼错 */
export const SERVICES = {
  store: 'store',
  channel: 'channel',
  gateway: 'gateway',
  llm: 'llm',
  harness: 'harness',
} as const

/**
 * 数一个应用级事件上有多少个监听者。
 *
 * 用途：判断「有没有插件在消费 qm/inbound」。返回 null 表示当前 cordis
 * 版本没有暴露可读的监听表（此时调用方应视为未知，而不是 0）。
 * 依赖 cordis 的 events._hooks 内部结构，升级时需回归 doctor 与 /healthz。
 */
export function listenerCount(ctx: { events?: unknown }, event: string): number | null {
  const hooks = (ctx.events as { _hooks?: Record<string, unknown> } | undefined)?._hooks
  if (!hooks) return null
  const list = hooks[event]
  if (list === undefined) return 0
  return Array.isArray(list) ? list.length : null
}
