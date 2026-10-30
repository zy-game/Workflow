/**
 * @qingmei/qm-agent —— P1 对话代理。
 *
 * 一个回合：qm/inbound 进 → 读历史并组装上下文 → 流式取模型输出（边收边广播）
 * → 落库 user/assistant 两条消息 → 报 qm/turn/end → 把完整回复回投到来源渠道。
 *
 * 并发策略：同一 sessionId 的回合串行排队，不同 sessionId 各自独立。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  textOf,
  uid,
  type ChatMessage,
  type ChannelService,
  type GatewayService,
  type HarnessService,
  type InboundMessage,
  type MemoryService,
  type Row,
  type StoreService,
  type TurnChunk,
  type TurnEnd,
} from '@qingmei/core'
import type { LlmService } from '@qingmei/service-llm'

export interface AgentConfig {
  /** 注入 system 消息的人格设定 */
  persona: string
}

export const name = 'qm-agent'

/** cordis 会等这四个服务就绪后才执行 apply，卸载时自动停用本插件 */
export const inject: string[] = ['llm', 'store', 'channel', 'gateway']

/** qm_message 表名 */
const MESSAGE_COLLECTION = 'qm_message'

/** 组装上下文时回读的历史条数上限 */
const HISTORY_LIMIT = 20

/** 出错时给用户看的固定开头 */
const FALLBACK_PREFIX = '我这边出了点问题：'

/** qm_message 的 P1 行形状（docs/04 的完整字段在 P1 里只保留对话所需的最小集） */
interface StoredMessage extends Row {
  session_id: string
  role: 'user' | 'assistant'
  text: string
  created_at: number
}

export function apply(ctx: Context, config: AgentConfig): void {
  const persona = requirePersona(config)
  const llm = requireService<LlmService>(ctx, 'llm')
  const store = requireService<StoreService>(ctx, 'store')
  const channel = requireService<ChannelService>(ctx, 'channel')
  const gateway = requireService<GatewayService>(ctx, 'gateway')
  /** harness 是可选车道：存在就优先用，不存在或不可用则回落 llm */
  const harness = ctx.reflect.get('harness', false) as HarnessService | undefined
  /** memory 也是可选：有就注入召回结果，没有就跳过 */
  const memory = ctx.reflect.get('memory', false) as MemoryService | undefined

  /** 每个 sessionId 一条排队链，链上的回合按到达顺序执行 */
  const lanes = new Map<string, Promise<void>>()

  /** 本插件写入的时间戳单调递增，避免同一毫秒内的两条消息排序不稳定 */
  let lastCreatedAt = 0

  function nextCreatedAt(): number {
    lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1)
    return lastCreatedAt
  }

  // core 没有扩展 cordis 的 Events 接口，应用级事件名统一走 events 服务；
  // 它与 ctx.on / ctx.emit 是同一条总线，订阅同样随本插件卸载而释放。
  function publishChunk(sessionId: string, text: string): void {
    const chunk: TurnChunk = { sessionId, text }
    ctx.events.emit(EVENTS.turnChunk, chunk)
    gateway.publish({ type: 'chunk', data: chunk })
  }

  async function loadHistory(sessionId: string): Promise<ChatMessage[]> {
    const rows = await store.collection<StoredMessage>(MESSAGE_COLLECTION).find({
      where: { session_id: sessionId },
      order: [{ field: 'created_at', dir: 'desc' }],
      limit: HISTORY_LIMIT,
    })
    // store 只保证「按 created_at 降序取最近 N 条」，回读时翻回时间正序
    return rows.reverse().map((row) => ({ role: row.role, content: row.text }))
  }

  async function streamReply(
    sessionId: string,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<string> {
    const parts: string[] = []
    for await (const chunk of llm.chat({ messages, signal })) {
      if (chunk.type === 'done') break
      parts.push(chunk.text)
      publishChunk(sessionId, chunk.text)
    }
    const text = parts.join('')
    if (text.length === 0) throw new Error('模型没有返回任何内容')
    return text
  }

  async function persistTurn(sessionId: string, userText: string, reply: string): Promise<void> {
    const collection = store.collection<StoredMessage>(MESSAGE_COLLECTION)
    // 两条消息必须同生共死：只写进 user 而没有 assistant，历史里会留下无回复的孤儿。
    await store.transaction(async () => {
      await collection.insert({
        id: uid('msg'),
        session_id: sessionId,
        role: 'user',
        text: userText,
        created_at: nextCreatedAt(),
      })
      await collection.insert({
        id: uid('msg'),
        session_id: sessionId,
        role: 'assistant',
        text: reply,
        created_at: nextCreatedAt(),
      })
    })
  }

  async function runTurn(message: InboundMessage): Promise<void> {
    const sessionId = sessionIdOf(message)
    const userText = textOf(message.blocks)
    /** 回合里所有可上报的失败，按发生顺序累积；非空即 ok=false */
    const problems: string[] = []
    const controller = new AbortController()
    let reply = ''

    /** 召回失败不能影响对话：退化成"这次没有记忆" */
    let memoryText = ''
    if (memory) {
      try {
        memoryText = (await memory.recall({ text: userText })).text
      } catch (error) {
        problems.push(`记忆召回失败：${messageOf(error)}`)
      }
    }

    try {
      // 车道选择：装了 harness 且能握手，就用它（有自己的会话/工具/压缩）；
      // 否则回落 llm，并把降级记进 problems，避免静默换脑。
      let mode: 'harness' | 'llm' = 'llm'
      if (harness) {
        const ok = await harness.available().catch(() => false)
        if (ok) mode = 'harness'
        else problems.push('harness 不可用，已降级到 llm')
      }

      if (mode === 'harness' && harness) {
        for await (const event of harness.run({
          conversationId: sessionId,
          // DSH 自己维护会话历史；把召回结果作为前缀附在这一轮输入上
          text: memoryText ? `【已知记忆】\n${memoryText}\n\n${userText}` : userText,
          signal: controller.signal,
        })) {
          if (event.type === 'text') {
            reply += event.text
            publishChunk(sessionId, event.text)
          } else if (event.type === 'error') {
            problems.push(event.message)
          }
        }
        if (!reply) {
          problems.push('harness 没有返回文本')
          reply = `${FALLBACK_PREFIX}${problems[0]}`
        }
      } else {
        const messages: ChatMessage[] = [
          { role: 'system', content: memoryText ? `${persona}\n\n【已知记忆】\n${memoryText}` : persona },
          ...(await loadHistory(sessionId)),
          { role: 'user', content: userText },
        ]
        reply = await streamReply(sessionId, messages, controller.signal)
      }
    } catch (error) {
      controller.abort()
      problems.push(messageOf(error))
      reply = `${FALLBACK_PREFIX}${problems[0]}`
    }

    try {
      await persistTurn(sessionId, userText, reply)
    } catch (error) {
      problems.push(`写入会话记录失败：${messageOf(error)}`)
    }

    try {
      const result = await channel.send({
        channel: message.channel,
        conversationId: message.conversation.id,
        blocks: [{ type: 'text', text: reply }],
      })
      if (!result.ok) problems.push(`渠道发送失败：${result.error ?? '未知原因'}`)
    } catch (error) {
      problems.push(`渠道发送失败：${messageOf(error)}`)
    }

    // 渠道结果也是回合结果的一部分，所以 turn/end 放在发送之后，ok/error 才是真实状态
    const end: TurnEnd = { sessionId, ok: problems.length === 0, text: reply, userText }
    if (problems.length > 0) end.error = problems.join('；')
    ctx.events.emit(EVENTS.turnEnd, end)
  }

  function enqueue(sessionId: string, task: () => Promise<void>): void {
    const previous = lanes.get(sessionId) ?? Promise.resolve()
    const current = previous.then(task, task).catch((error) => {
      // runTurn 自己兜底；能到这里的只有排队/收尾阶段的意外异常
      ctx.logger.error(`[qm-agent] 回合异常（${sessionId}）：${messageOf(error)}`)
    })
    lanes.set(sessionId, current)
    const release = (): void => {
      if (lanes.get(sessionId) === current) lanes.delete(sessionId)
    }
    void current.then(release, release)
  }

  ctx.events.on(EVENTS.inbound, (message: InboundMessage) => {
    try {
      const sessionId = sessionIdOf(message)
      enqueue(sessionId, () => runTurn(message))
    } catch (error) {
      // 监听器抛错会打断发事件的一方，这里必须就地吞掉并记录
      ctx.logger.error(`[qm-agent] 收到无法处理的入站消息：${messageOf(error)}`)
    }
  })
}

function sessionIdOf(message: InboundMessage): string {
  return 's_' + message.conversation.id
}

function requirePersona(config: AgentConfig): string {
  if (typeof config?.persona !== 'string' || config.persona.trim().length === 0) {
    throw new TypeError('qm-agent 需要 config.persona：一个非空字符串')
  }
  return config.persona
}

/**
 * 取一个已注册的服务。
 *
 * inject 正常工作时服务必然存在；这里显式检查是为了让「绕过 cordis 直接调 apply」
 * 这种误用立刻报出缺哪个服务，而不是在回合中途抛一个找不到属性的 TypeError。
 */
function requireService<T>(ctx: Context, key: string): T {
  const value = ctx.reflect.get(key, false) as T | undefined
  if (!value) {
    throw new Error(`qm-agent 缺少必需服务 "${key}"：请先加载提供它的插件`)
  }
  return value
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

/** 兼容 `import Agent from '@qingmei/qm-agent'` 的组合根写法 */
export default { name, apply, inject }
