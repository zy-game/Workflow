/**
 * @qingmei/qm-agent —— P1 对话代理。
 *
 * 一个回合：qm/inbound 进 → 读历史并组装上下文 → 流式取模型输出（边收边广播）
 * → 把完整回复回投到来源渠道 → 报 qm/turn/end。
 *
 * 落库不在这里：用户消息由 qm-history 订阅 qm/inbound 写，助手消息由它订阅
 * qm/outbound（渠道投递成功后）写。本插件只读 qm_message 组装上下文。
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
  type IdentityService,
  type InboundMessage,
  type AuditService,
  type ConversationPolicy,
  type ConversationProfileService,
  type MemoryService,
  type ProfileEntry,
  type SkillService,
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
export const inject: string[] = ['llm', 'store', 'channel', 'gateway', 'memory']

/** qm_message 表名 */
const MESSAGE_COLLECTION = 'qm_message'

/** 组装上下文时回读的历史条数上限 */
const HISTORY_LIMIT = 20

/** 出错时给用户看的固定开头 */
const FALLBACK_PREFIX = '我这边出了点问题：'

/**
 * 输出卫生：用户不该看到内部工具名、MCP 前缀、绝对路径与权限策略。
 * 这是 A 类边界，不能只靠人格提示词。
 */
const INTERNAL_PATTERNS: RegExp[] = [
  /mcp__[A-Za-z0-9_]+/g,
  /\/(?:opt|home|var|usr|root)\/[^\s，。；、)]*/g,
  /\bworkspace-(?:write|read)\b/gi,
]

const TOOL_NAMES = [
  'bash',
  'pwsh',
  'glob',
  'grep',
  'read_image',
  'subagent',
  'subagent_fork',
  'workflow',
  'todo_write',
  'create_goal',
  'update_goal',
  'exit_plan_mode',
  'job_list',
  'job_output',
  'job_kill',
  'send_message',
  'interrupt_agent',
  'list_agents',
]

export function sanitizeReply(text: string): string {
  let out = text
  for (const pattern of INTERNAL_PATTERNS) out = out.replace(pattern, '（内部信息已隐藏）')
  for (const name of TOOL_NAMES) out = out.split(`\`${name}\``).join('某个工具')
  return out
}

/** 画像 → 提示词里的稳定段：每个 subject 一行，事实按 predicate 拼起来 */
/** 禁止话题 → 关键词模式；后置校验用（docs/11 §8） */
export const FORBIDDEN_PATTERNS: Record<string, RegExp> = {
  task: /任务|进度|项目|排期/,
  schedule: /日程|提醒|会议/,
  memory: /记忆|画像|记得你/,
  internal: /内部|内网|合同|报价/,
}

/** 手机号、身份证、内网地址 */
export const SENSITIVE_PATTERNS: RegExp[] = [
  /1[3-9]\d{9}/,
  /\d{17}[\dXx]/,
  /https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/,
]

/** 命中则返回原因，否则 null */
export function groupPolicyViolation(reply: string, policy: ConversationPolicy): string | null {
  for (const topic of policy.forbiddenTopics) {
    const pattern = FORBIDDEN_PATTERNS[topic]
    if (pattern && pattern.test(reply)) return topic
  }
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(reply))) return 'sensitive'
  return null
}
export function formatProfile(entries: ProfileEntry[]): string {
  return entries
    .map((entry) => {
      const facts = entry.facts.map((fact) => `${fact.predicate}${fact.object}`).join('；')
      return facts ? `- ${entry.subject}：${facts}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

/** qm_message 的 P1 行形状（docs/04 的完整字段在 P1 里只保留对话所需的最小集） */
interface StoredMessage extends Row {
  session_id: string
  role: 'user' | 'assistant'
  text: string
  /** 入站消息的平台 id，用于把「本轮消息」从历史里摘出去 */
  platform_message_id?: string
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
  /** 记忆是核心依赖（docs/02）：缺失时插件不会 ACTIVE，而不是静默降级成「没有记忆」 */
  const memory = requireService<MemoryService>(ctx, 'memory')

  /** 每个 sessionId 一条排队链，链上的回合按到达顺序执行 */
  const lanes = new Map<string, Promise<void>>()

  // core 没有扩展 cordis 的 Events 接口，应用级事件名统一走 events 服务；
  // 它与 ctx.on / ctx.emit 是同一条总线，订阅同样随本插件卸载而释放。
  function publishChunk(sessionId: string, text: string): void {
    const chunk: TurnChunk = { sessionId, text }
    ctx.events.emit(EVENTS.turnChunk, chunk)
    gateway.publish({ type: 'chunk', data: chunk })
  }

  /**
   * 取本会话「本轮之前」的历史。
   *
   * 用户消息在 qm/inbound 时就被 qm-history 落库了，所以历史里可能已经有本轮这条，
   * 甚至已经有排在后面的消息。按 platformMessageId 找到本轮那条，截断到它之前，
   * 再由调用方把当前 userText 补在最后——上下文才和「此刻」对齐。
   */
  async function loadHistory(sessionId: string, platformMessageId: string): Promise<ChatMessage[]> {
    const rows = await store.collection<StoredMessage>(MESSAGE_COLLECTION).find({
      where: { session_id: sessionId },
      order: [{ field: 'created_at', dir: 'desc' }],
      // 多取一条：历史里可能已经有本轮这条，截掉之后仍要凑满 HISTORY_LIMIT
      limit: HISTORY_LIMIT + 1,
    })
    // store 只保证「按 created_at 降序取最近 N 条」，回读时翻回时间正序
    const ordered = rows.reverse()
    const cut = ordered.findIndex((row) => row.platform_message_id === platformMessageId)
    const past = cut >= 0 ? ordered.slice(0, cut) : ordered
    return past.slice(-HISTORY_LIMIT).map((row) => ({ role: row.role, content: row.text }))
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

  async function runTurn(message: InboundMessage): Promise<void> {
    // 被审批等控制指令消费掉的消息不再进入对话回合
    if (message.handledBy) return

    // 身份闸：私聊必须解析到 owner；每渠道首个私聊自动绑 owner（单用户部署）
    if (message.conversation.kind !== 'group') {
      const identity = ctx.reflect.get('identity', false) as IdentityService | undefined
      if (identity) {
        const actor =
          (await identity.resolve(message.channel, message.sender.platformUserId)) ??
          (await identity.ensureOwner(
            message.channel,
            message.sender.platformUserId,
            message.sender.displayName,
          ))
        if (!actor || actor.role !== 'owner') {
          await channel
            .send({
              channel: message.channel,
              conversationId: message.conversation.id,
              blocks: [{ type: 'text', text: '未授权：请先在设置里绑定账号' }],
            })
            .catch(() => undefined)
          return
        }
      }
    }
    const sessionId = sessionIdOf(message)
    const userText = textOf(message.blocks)
    const traceId = uid('turn')
    const startedAt = Date.now()
    // 轮到这条消息了：先报 turn/start，qm-history 按这个顺序写用户消息
    ctx.events.emit(EVENTS.turnStart, { sessionId, traceId, message })
    /** 回合里所有可上报的失败，按发生顺序累积；非空即 ok=false */
    const problems: string[] = []
    const controller = new AbortController()
    let reply = ''

    // 视口决定能看到哪些记忆：群聊只注入该群的 public 事实（docs/05 M1 验收第 5 条）
    // 群视口带上渠道前缀：不同渠道的会话 id 即使撞了也不会互相看到
    const audience =
      message.conversation.kind === 'group'
        ? `group:${message.channel}:${message.conversation.id}`
        : 'owner'

    /** 召回失败不能影响对话：退化成"这次没有记忆" */
    let memoryText = ''
    /** 画像只对 owner 开：稳定事实，不依赖这句话的关键词 */
    let profileText = ''
    if (memory) {
      try {
        memoryText = (await memory.recall({ text: userText, audience, sessionId })).text
      } catch (error) {
        problems.push(`记忆召回失败：${messageOf(error)}`)
      }
      if (audience === 'owner') {
        try {
          profileText = formatProfile(await memory.profile({ audience }))
        } catch (error) {
          problems.push(`画像读取失败：${messageOf(error)}`)
        }
      }
    }
    // 群策略：标签合并后的规则注入 prompt（长度/口吻/禁止话题），并在发送前截断
    const profiles = ctx.reflect.get('conversationProfile', false) as ConversationProfileService | undefined
    let groupNote = ''
    let maxChars = 0
    let policy: ConversationPolicy | null = null
    if (audience !== 'owner' && profiles) {
      try {
        const profile = await profiles.get(message.channel, message.conversation.id)
        if (profile) {
          groupNote = profiles.note(profile)
          policy = profiles.policy(profile)
          maxChars = policy.maxChars
        }
      } catch (error) {
        problems.push(`群策略读取失败：${messageOf(error)}`)
      }
    }
    let skillsText = ''
    const skills = ctx.reflect.get('skills', false) as SkillService | undefined
    if (skills && audience === 'owner') {
      try {
        const list = await skills.list()
        if (list.length > 0) {
          skillsText = [
            '【可用技能】',
            ...list.slice(0, 8).map((item) => `- ${item.name}：${item.description || '（无描述）'}`),
            '需要时用 qm_skill_read 读完整步骤。',
          ].join('\n')
        }
      } catch (error) {
        problems.push(`技能读取失败：${messageOf(error)}`)
      }
    }

    const memoryBlock = [
      profileText ? `【关于主人】\n${profileText}` : '',
      memoryText ? `【已知记忆】\n${memoryText}` : '',
      groupNote ? `【本群规则】\n${groupNote}` : '',
      skillsText,
    ].filter(Boolean).join('\n\n')

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
          text: memoryBlock ? `${memoryBlock}\n\n${userText}` : userText,
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
          { role: 'system', content: memoryBlock ? `${persona}\n\n${memoryBlock}` : persona },
          ...(await loadHistory(sessionId, message.platformMessageId)),
          { role: 'user', content: userText },
        ]
        reply = await streamReply(sessionId, messages, controller.signal)
      }
    } catch (error) {
      controller.abort()
      problems.push(messageOf(error))
      reply = `${FALLBACK_PREFIX}${problems[0]}`
    }

    // 先过滤再发送：用户看到的与历史里存的都必须是干净的
    reply = sanitizeReply(reply)
    if (maxChars > 0 && reply.length > maxChars) {
      reply = `${reply.slice(0, Math.max(0, maxChars - 1))}…`
    }

    // 第二道闸：群策略后置校验（docs/11 §8）
    if (policy) {
      const violation = groupPolicyViolation(reply, policy)
      if (violation) {
        reply = '这个在群里不方便说，私聊我。'
        const audit = ctx.reflect.get('audit', false) as AuditService | undefined
        void audit
          ?.append({
            at: new Date(),
            actorId: 'bot',
            channel: message.channel,
            action: 'group.reply.blocked',
            target: message.conversation.id,
            decision: 'deny',
            detail: { reason: violation },
            traceId,
          })
          .catch(() => undefined)
      }
    }

    try {
      const result = await channel.send({
        channel: message.channel,
        conversationId: message.conversation.id,
        blocks: [{ type: 'text', text: reply }],
        traceId,
      })
      if (!result.ok) problems.push(`渠道发送失败：${result.error ?? '未知原因'}`)
    } catch (error) {
      problems.push(`渠道发送失败：${messageOf(error)}`)
    }

    // 渠道结果也是回合结果的一部分，所以 turn/end 放在发送之后，ok/error 才是真实状态
    const end: TurnEnd = {
      sessionId,
      traceId,
      ok: problems.length === 0,
      text: reply,
      userText,
      latencyMs: Date.now() - startedAt,
    }
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
