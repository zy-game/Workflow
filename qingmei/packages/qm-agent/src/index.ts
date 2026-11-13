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
  conversationIdFromSession,
  HistoryService,
  conversationSessionId,
  textOf,
  uid,
  type ChatMessage,
  type ApprovalRequest,
  type ChannelId,
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
  type TurnChunk,
  type ThreadService,
  type TurnEnd,
  type TaskRun,
  type Scheduled,
} from '@qingmei/core'
import type { LlmService, ScheduleService, TaskService } from '@qingmei/core'

export interface AgentConfig {
  /** 注入 system 消息的人格设定 */
  persona?: string
  /** 晨间计划小时（本地时区，默认 8） */
  planHour?: number
  /** 晚间日记小时（本地时区，默认 22） */
  journalHour?: number
  /** 关掉每日仪式 */
  rituals?: boolean
  /** 主动发消息（晨间计划、任务完成）；默认开 */
  proactiveChat?: boolean
  /** 主动消息每天上限 */
  proactiveMaxPerDay?: number
  /** 两条主动消息最小间隔（分钟） */
  proactiveGapMinutes?: number
  /** 免打扰开始/结束小时（相同则关闭免打扰） */
  quietStart?: number
  quietEnd?: number
  /** 随机心跳：每隔一段时间掷一次骰子，决定要不要主动开口 */
  randomHeartbeat?: boolean
  heartbeatMinMinutes?: number
  heartbeatMaxMinutes?: number
  heartbeatWeekendMinMinutes?: number
  heartbeatWeekendMaxMinutes?: number
  heartbeatMaxChat?: number
  heartbeatMaxPlay?: number
  /** 当日花费超过这个数就不主动开口（元） */
  heartbeatBudgetYuan?: number
  heartbeatStart?: number
  heartbeatEnd?: number
}

export function heartbeatKindFor(chat: number, play: number, maxChat: number, maxPlay: number): 'chat' | 'play' | null {
  if (play < maxPlay && (chat % 3 === 2 || chat >= maxChat)) return 'play'
  if (chat < maxChat) return 'chat'
  return null
}

export const name = 'qm-agent'

/** cordis 会等这四个服务就绪后才执行 apply，卸载时自动停用本插件 */
export const inject: string[] = ['channel', 'gateway', 'memory']

/** 组装上下文时回读的历史条数上限 */
const HISTORY_LIMIT = 20

/** 出错时给用户看的固定开头 */
const FALLBACK_PREFIX = '我这边出了点问题：'

/**
 * 从用户话里解析时间窗（只认常见说法，解析不了就返回 null，不做猜测）。
 * 「上周三我让你改了什么」这类问题，召回必须先有时间范围，否则只能碰关键词。
 */
export function parseTimeRange(text: string, now: Date = new Date()): { since: Date; until: Date } | null {
  const value = String(text ?? '')
  const dayStart = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const DAILY = 86_400_000

  const lastDays = /(?:最近|近)\s*(\d{1,3})\s*天/.exec(value)
  if (lastDays) {
    const days = Math.max(1, Number(lastDays[1]))
    return { since: new Date(now.getTime() - days * DAILY), until: now }
  }
  if (/前天/.test(value)) {
    const start = dayStart(now)
    start.setDate(start.getDate() - 2)
    return { since: start, until: new Date(start.getTime() + DAILY) }
  }
  if (/昨天|昨日/.test(value)) {
    const start = dayStart(now)
    start.setDate(start.getDate() - 1)
    return { since: start, until: new Date(start.getTime() + DAILY) }
  }
  if (/今天|今日|刚才|刚刚/.test(value)) return { since: dayStart(now), until: now }
  if (/本周|这周|这星期/.test(value)) {
    const start = dayStart(now)
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
    return { since: start, until: now }
  }
  if (/上周/.test(value)) {
    const start = dayStart(now)
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 7)
    return { since: start, until: new Date(start.getTime() + 7 * DAILY) }
  }
  if (/上个月|上月/.test(value)) {
    return {
      since: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      until: new Date(now.getFullYear(), now.getMonth(), 1),
    }
  }
  if (/本月|这个月/.test(value)) return { since: new Date(now.getFullYear(), now.getMonth(), 1), until: now }
  if (/去年/.test(value)) {
    return { since: new Date(now.getFullYear() - 1, 0, 1), until: new Date(now.getFullYear(), 0, 1) }
  }
  if (/今年/.test(value)) return { since: new Date(now.getFullYear(), 0, 1), until: now }
  return null
}

/** 最近活动的确定性摘要：不调模型，直接从任务账本和日程生成 */
export function formatRecentActivity(input: { tasks: TaskRun[]; schedules: Scheduled[]; now?: Date }): string {
  const now = input.now ?? new Date()
  const weekAgo = now.getTime() - 7 * 86_400_000
  const recent = input.tasks.filter((run) => run.createdAt.getTime() >= weekAgo)
  const active = input.tasks.filter(
    (run) => run.status === 'running' || run.status === 'queued' || run.status === 'needs_approval',
  )
  const done = recent.filter((run) => run.status === 'done')
  const failed = recent.filter((run) => run.status === 'failed')
  const lines: string[] = []
  if (active.length > 0) {
    lines.push(`进行中/排队：${active.length} 个`)
    for (const run of active.slice(0, 5)) {
      const label = run.status === 'running' ? '进行中' : run.status === 'queued' ? '排队' : '待确认'
      lines.push(`- ${label}：${run.title}`)
    }
  }
  if (recent.length > 0) {
    lines.push(`任务：7 天内完成 ${done.length}，失败 ${failed.length}`)
    for (const run of done.slice(0, 5)) lines.push(`- 完成：${run.title}`)
    for (const run of failed.slice(0, 3)) lines.push(`- 失败：${run.title}`)
  }
  const todayKey = now.toDateString()
  const todays = input.schedules
    .filter((item) => item.nextAt.toDateString() === todayKey)
    .sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime())
  const upcoming = input.schedules
    .filter((item) => item.nextAt.getTime() >= now.getTime() && item.nextAt.toDateString() !== todayKey)
    .sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime())
    .slice(0, 3)
  for (const item of todays) {
    lines.push(`- 今日日程：${item.nextAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} ${item.text}`)
  }
  for (const item of upcoming) {
    lines.push(`- 日程：${item.nextAt.toLocaleString('zh-CN')} ${item.text}`)
  }
  return lines.join('\n')
}

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

export const ACTION_PROTOCOL = [
  '【行动协议】',
  '你能在回复末尾输出一个或多个行动块，行动块不会展示给用户：',
  '<qm-action>{"kind":"task.create","title":"短标题","prompt":"给执行器的一句话任务","project":"可选的项目名"}</qm-action>',
  '<qm-action>{"kind":"task.create","taskKind":"goal","origin":"self","title":"我自己想做的事","prompt":"为什么想做、想怎么做"}</qm-action>',
  '<qm-action>{"kind":"approval.request","action":"qm.plan","prompt":"要不要我帮你规划明天出行计划和路线？","reason":"用户表达了一个愿望但还没决定"}</qm-action>',
  '判断规则：',
  '- 用户明确要求做事（如「审查一下三国项目的进度」「把 X 查一下」）：输出 task.create；',
  '- 你自己想做的事（好奇、想整理、想学、长期目标）：输出 taskKind=goal、origin=self 的 task.create；',
  '- 用户表达模糊愿望或两难（如「明天想去看演唱会，但又想看电影」）：输出 approval.request，先问一句要不要规划；',
  '- 普通聊天、问答、情绪表达：不要输出行动块；',
  '- 行动块只能放在回复最后，不要在正文里解释它。',
].join('\n')

export interface AgentAction {
  kind: 'task.create' | 'approval.request'
  title?: string
  prompt?: string
  project?: string
  action?: string
  reason?: string
  taskKind?: 'goal'
  origin?: 'self'
}

/** 从模型输出里抽出行动块；正文里的块会被移除 */
export function extractActions(raw: string): { visible: string; actions: AgentAction[] } {
  const actions: AgentAction[] = []
  const accept = (value: unknown): AgentAction | null => {    if (!value || typeof value !== 'object') return null
    const item = value as Record<string, unknown>
    if (item.kind === 'task.create' && typeof item.prompt === 'string' && item.prompt.trim()) {
      return item as unknown as AgentAction
    }
    if (item.kind === 'approval.request' && typeof item.prompt === 'string' && item.prompt.trim()) {
      return item as unknown as AgentAction
    }
    // 模型偶尔会把自我目标写成 {"taskKind":"goal",...} 的代码块
    if (item.taskKind === 'goal' && (typeof item.title === 'string' || typeof item.detail === 'string')) {
      const title = String(item.title ?? item.detail ?? '').slice(0, 80)
      return {
        kind: 'task.create',
        taskKind: 'goal',
        origin: 'self',
        title,
        prompt: String(item.detail ?? item.prompt ?? title),
      }
    }
    return null
  }
  const parseLoose = (text: string): AgentAction | null => {
    const map: Record<string, string> = {}
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z]+)\s*[=:]\s*(.+)$/.exec(line)
      if (match) map[match[1]!.toLowerCase()] = match[2]!.trim()
    }
    const prompt = map.objective ?? map.detail ?? map.title ?? ''
    if (!prompt) return null
    return {
      kind: 'task.create',
      ...(map.taskkind === 'goal' || map.origin === 'self' ? { taskKind: 'goal' as const } : {}),
      ...(map.origin === 'self' ? { origin: 'self' as const } : {}),
      title: prompt.slice(0, 60),
      prompt,
    }
  }
  let visible = raw.replace(/<qm-action>([\s\S]*?)<\/qm-action>/g, (_match, body: string) => {
    try {
      const action = accept(JSON.parse(body))
      if (action) actions.push(action)
      else {
        const loose = parseLoose(body)
        if (loose) actions.push(loose)
      }
    } catch {
      const loose = parseLoose(body)
      if (loose) actions.push(loose)
    }
    return ''
  })
  visible = visible.replace(/```(?:action|json)?\s*([\s\S]*?)```/g, (match, body: string) => {
    try {
      const action = accept(JSON.parse(body))
      if (action) {
        actions.push(action)
        return ''
      }
    } catch {
      const loose = parseLoose(body)
      if (loose) {
        actions.push(loose)
        return ''
      }
    }
    return match
  })
  // 模型偶尔写成 XML 风格：<action taskKind="goal" origin="self">objective: …</action>
  visible = visible.replace(/<action([^>]*)>([\s\S]*?)<\/action>/g, (match, attrs: string, body: string) => {
    const taskKind = /taskKind\s*=\s*["']?(\w+)/.exec(attrs)?.[1]
    const origin = /origin\s*=\s*["']?(\w+)/.exec(attrs)?.[1]
    let prompt = ''
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      const action = accept(parsed)
      if (action) {
        actions.push(action)
        return ''
      }
    } catch {
      // 不是 JSON，按 YAML 风格读取 objective/detail/title
    }
    const field = /^\s*(?:objective|detail|title)\s*[=:]\s*([\s\S]+)$/i.exec(body.trim())
    prompt = (field?.[1] ?? body).trim()
    if (prompt) {
      actions.push({
        kind: 'task.create',
        ...(taskKind === 'goal' ? { taskKind: 'goal' as const } : {}),
        ...(origin === 'self' ? { origin: 'self' as const } : {}),
        title: prompt.slice(0, 60),
        prompt,
      })
      return ''
    }
    return match
  })
  return { visible: visible.trim(), actions }
}

/**
 * 流式过滤：正文照常吐，遇到 <qm-action> 就吞到 </qm-action>。
 * 为了不让标记被拆到两个 chunk，尾巴上最多留 12 个字符不吐。
 */
function partialMarkerLength(text: string): number {
  const marker = '<qm-action'
  for (let length = Math.min(marker.length - 1, text.length); length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) return length
  }
  return 0
}

export class ActionFilter {
  private buffer = ''
  private suppressed = false

  push(chunk: string): string {
    this.buffer += chunk
    let out = ''
    for (;;) {
      if (this.suppressed) {
        const end = this.buffer.indexOf('</qm-action>')
        if (end < 0) return out
        this.buffer = this.buffer.slice(end + '</qm-action>'.length)
        this.suppressed = false
        continue
      }
      const start = this.buffer.indexOf('<qm-action')
      if (start >= 0) {
        out += this.buffer.slice(0, start)
        this.buffer = this.buffer.slice(start)
        const end = this.buffer.indexOf('</qm-action>')
        if (end < 0) {
          this.suppressed = true
          return out
        }
        this.buffer = this.buffer.slice(end + '</qm-action>'.length)
        continue
      }
      const hold = partialMarkerLength(this.buffer)
      out += this.buffer.slice(0, this.buffer.length - hold)
      this.buffer = this.buffer.slice(this.buffer.length - hold)
      return out
    }
  }

  finish(): string {
    const rest = this.suppressed ? '' : this.buffer
    this.buffer = ''
    this.suppressed = false
    const partial = rest.lastIndexOf('<qm-action')
    return partial >= 0 ? rest.slice(0, partial) : rest
  }
}

export function apply(ctx: Context, config: AgentConfig): void {
  const personaService = ctx.get('persona', false) as { current: () => { prompt: string } } | undefined
  const persona = personaService?.current().prompt || requirePersona(config)
  const llm = ctx.get('llm', false) as LlmService | undefined
  const channel = ctx.channel
  const gateway = ctx.gateway
  let channelTargetsService:
    | { list: () => Promise<Array<{ channel: string; conversationId: string }>> }
    | undefined
  ctx.inject(['channelTargets'], (sub) => {
    channelTargetsService = sub.channelTargets as unknown as typeof channelTargetsService
  })
  /** 记忆是核心依赖（docs/02）：缺失时插件不会 ACTIVE，而不是静默降级成「没有记忆」 */
  const memory = ctx.memory

  // 可选增强：由 Cordis 在服务出现时注入，不在业务代码里查字符串。
  let harness: HarnessService | undefined
  let historyService: HistoryService | undefined
  let identityService: IdentityService | undefined
  let threadService: ThreadService | undefined
  let profileService: ConversationProfileService | undefined
  let skillService: SkillService | undefined
  let auditService: AuditService | undefined
  let taskService: TaskService | undefined
  let costService: { summary: () => Promise<{ text: string; spentSinceYesterday: number | null }> } | undefined
  let scheduleService: ScheduleService | undefined
  ctx.inject(['harness'], (sub) => { harness = sub.harness })
  ctx.inject(['history'], (sub) => { historyService = sub.history })
  ctx.inject(['identity'], (sub) => { identityService = sub.identity })
  ctx.inject(['thread'], (sub) => { threadService = sub.thread })
  ctx.inject(['conversationProfile'], (sub) => { profileService = sub.conversationProfile })
  ctx.inject(['skills'], (sub) => { skillService = sub.skills })
  ctx.inject(['audit'], (sub) => { auditService = sub.audit })
  ctx.inject(['task'], (sub) => { taskService = sub.task })
  ctx.inject(['schedule'], (sub) => { scheduleService = sub.schedule })
  ctx.inject(['cost'], (sub) => { costService = (sub as unknown as { cost: { summary: () => Promise<{ text: string; spentSinceYesterday: number | null }> } }).cost })
  let storeService:
    | {
        collection: (name: string) => {
          get: (id: string) => Promise<unknown>
          insert: (value: unknown) => Promise<unknown>
          update: (id: string, patch: unknown) => Promise<void>
          delete: (id: string) => Promise<boolean>
        }
      }
    | undefined
  ctx.inject(['store'], (sub) => {
    storeService = (sub as unknown as { store: NonNullable<typeof storeService> }).store
  })
  let deviceService: {
    list: () => Promise<Array<{ id: string; name: string; workspaces?: Array<{ id: string; title: string; path: string }> }>>
  } | undefined
  ctx.inject(['devices'], (sub) => {
    deviceService = (sub as unknown as { devices: NonNullable<typeof deviceService> }).devices
  })
  let approvalService:
    | { create: (input: { action: string; prompt: string; requester?: string }) => Promise<{ id: string }> }
    | undefined
  ctx.inject(['approval'], (sub) => {
    approvalService = (sub as unknown as { approval: NonNullable<typeof approvalService> }).approval
  })
  let portraitService:
    | {
        self: () => Promise<{ persona: string } | null>
        person: () => Promise<{ traits: string[] } | null>
        group: (id: string) => Promise<{ name: string; rules: { blocked?: string[]; requireApproval?: boolean; note?: string } } | null>
      }
    | undefined
  ctx.inject(['portrait'], (sub) => {
    portraitService = (sub as unknown as { portrait: NonNullable<typeof portraitService> }).portrait
  })
  let psycheService:
    | {
        context: () => Promise<string>
        journals: (limit?: number) => Promise<Array<{ day: string; text: string }>>
        relation: () => Promise<{ events: Array<{ text: string; kind: string }> }>
        writeJournal: (text: string, day?: string) => Promise<unknown>
        writeNote: (kind: 'plan' | 'review', text: string, day?: string) => Promise<unknown>
      }
    | undefined
  ctx.inject(['psyche'], (sub) => {
    psycheService = (sub as unknown as { psyche: NonNullable<typeof psycheService> }).psyche
  })

  /** 待确认的“派任务到工作区”：按会话保存一次，避免猜测 */
  const pendingDispatch = new Map<
    string,
    { deviceId: string; workspaceId: string; title: string; path: string; prompt: string; taskTitle: string }
  >()
  /** 已派出、等结果的检查任务：完成后把结论回投原会话 */
  const pendingResults = new Map<string, { channel: ChannelId; conversationId: string; title: string }>()

  ctx.events.on(EVENTS.taskFinished, (run: TaskRun) => {
    void (async () => {
      const stored = storeService
        ? await storeService.collection('qm_pending_result').get(run.id).catch(() => null)
        : null
      const pending = pendingResults.get(run.id)
      if (!pending && !stored) return
      const target = pending ?? {
        channel: String((stored as { channel: string }).channel) as ChannelId,
        conversationId: String((stored as { conversation_id: string }).conversation_id),
        title: String((stored as { title: string }).title),
      }
      pendingResults.delete(run.id)
      if (storeService) void storeService.collection('qm_pending_result').delete(run.id).catch(() => undefined)
      const conclusion = String(run.result ?? '').trim()
      const text =
        run.status === 'done'
          ? `「${target.title}」检查完成：\n${conclusion.slice(0, 800) || '（没有返回结论）'}`
          : `「${target.title}」检查失败：${run.error ?? '未知原因'}`
      await channel
        .send({ channel: target.channel, conversationId: target.conversationId, blocks: [{ type: 'text', text }] })
        .catch(() => undefined)
    })()
  })

  ctx.events.on(EVENTS.approvalDecided, (request: ApprovalRequest) => {
    void (async () => {
      const groupPending = storeService
        ? ((await storeService.collection('qm_group_pending').get(request.id).catch(() => null)) as {
            channel?: string
            conversation_id?: string
            text?: string
          } | null)
        : null
      if (groupPending) {
        void storeService?.collection('qm_group_pending').delete(request.id).catch(() => undefined)
        if (request.status === 'allowed' && groupPending.text) {
          await channel
            .send({
              channel: String(groupPending.channel ?? 'web') as ChannelId,
              conversationId: String(groupPending.conversation_id ?? ''),
              blocks: [{ type: 'text', text: groupPending.text }],
            })
            .catch(() => undefined)
        }
        return
      }
      const row = storeService
        ? ((await storeService.collection('qm_agent_approval').get(request.id).catch(() => null)) as {
            prompt?: string
            session_id?: string
          } | null)
        : null
      if (!row) return
      void storeService?.collection('qm_agent_approval').delete(request.id).catch(() => undefined)
      if (request.status !== 'allowed' || !taskService) return
      const prompt = String(row.prompt ?? '').trim()
      if (!prompt) return
      const title = `规划：${prompt}`.slice(0, 60)
      try {
        const run = await taskService.create({
          prompt: `为下面这个请求做一份可执行的计划（含步骤、时间、路线或取舍），给出结论：${prompt}`,
          title,
          target: { executorId: 'local' },
        })
        pendingResults.set(run.id, { channel: 'web', conversationId: 'owner', title })
        void storeService
          ?.collection('qm_pending_result')
          .insert({ id: run.id, channel: 'web', conversation_id: 'owner', title, at: Date.now() })
          .catch(() => undefined)
      } catch {
        // 审批通过但规划任务没建起来：下一轮对话可见
      }
    })()
  })

  /**
   * 任务结束后的一次内部思考：复用同一个 owner 会话，让人格自己判断要不要下一步。
   * 规则只做限额：每天最多 3 次、间隔 5 分钟、内部自建任务不再触发。
   */
  async function maybeThinkNext(run: TaskRun): Promise<void> {
    if (!harness || !storeService) return
    const originRow = (await storeService
      .collection('qm_task_origin')
      .get(run.id)
      .catch(() => null)) as { origin?: string } | null
    if (originRow?.origin === 'internal') return
    const state = (await storeService
      .collection('qm_agent_internal_state')
      .get('owner')
      .catch(() => null)) as { day?: string; count?: number; last_at?: number } | null
    const today = new Date().toDateString()
    const count = state?.day === today ? Number(state.count ?? 0) : 0
    if (count >= 3) return
    if (state?.last_at && Date.now() - state.last_at < 5 * 60_000) return
    const available = await harness.available().catch(() => false)
    if (!available) return
    if (run.status === 'done' && (run.origin === 'user' || run.origin === 'chat')) {
      await sendProactive(`「${run.title}」做完了。`, 'task-done')
    }
    const ownerSession = conversationSessionId('owner')
    const nextState = { day: today, count: count + 1, last_at: Date.now() }
    if (state) {
      await storeService.collection('qm_agent_internal_state').update('owner', nextState).catch(() => undefined)
    } else {
      await storeService
        .collection('qm_agent_internal_state')
        .insert({ id: 'owner', ...nextState })
        .catch(() => undefined)
    }

    const message: InboundMessage = {
      platformMessageId: `heartbeat_${run.id}_${Date.now()}`,
      channel: 'web',
      accountId: 'heartbeat',
      conversation: { kind: 'dm', id: 'owner' },
      sender: { platformUserId: 'heartbeat', displayName: '青梅' },
      blocks: [
        {
          type: 'text',
          text: [
            '【内部事件】不要把这条当成主人说的话，也不要回复主人。',
            `任务「${run.title}」刚结束：${run.status}。`,
            `结果：${String(run.result ?? run.error ?? '').slice(0, 600) || '无'}`,
            '根据你的人格和刚才的对话，判断要不要有下一步（建任务/提醒/申请规划）。',
            '需要就只输出行动块；不需要就回复"不用"。',
          ].join('\n'),
        },
      ],
      receivedAt: new Date(),
      internal: true,
      internalKind: 'heartbeat',
    }
    ctx.events.emit(EVENTS.inbound, message)
  }

  ctx.events.on(EVENTS.taskFinished, (run: TaskRun) => {
    void maybeThinkNext(run).catch(() => undefined)
  })

  const TIME_ZONE = 'Asia/Shanghai'

  function dayKeyOf(now = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now)
  }

  function hourOf(now = new Date()): number {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: '2-digit', hour12: false }).formatToParts(
      now,
    )
    return Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24
  }

  /** 主动发一条消息：Web 必发，外部渠道取最近一个绑定目标 */
  async function sendProactive(text: string, reason: string, force = false): Promise<boolean> {
    if (config.proactiveChat === false) return false
    const body = text.trim().slice(0, 800)
    if (!body) return false
    if (/^(不用|没事|没什么|没有)/.test(body)) return false
    const hour = hourOf()
    const quietStart = Math.min(23, Math.max(0, Number(config.quietStart ?? 23)))
    const quietEnd = Math.min(23, Math.max(0, Number(config.quietEnd ?? 8)))
    if (!force && quietStart !== quietEnd && (hour >= quietStart || hour < quietEnd)) return false
    const day = dayKeyOf()
    const max = Math.max(1, Number(config.proactiveMaxPerDay ?? 3))
    const gapMs = Math.max(1, Number(config.proactiveGapMinutes ?? 45)) * 60_000
    const state = storeService
      ? ((await storeService
          .collection('qm_proactive_state')
          .get('owner')
          .catch(() => null)) as { day?: string; count?: number; last_at?: number } | null)
      : null
    const count = state?.day === day ? Number(state.count ?? 0) : 0
    if (!force && count >= max) return false
    if (!force && state?.last_at && Date.now() - state.last_at < gapMs) return false
    await channel.send({ channel: 'web', conversationId: 'owner', blocks: [{ type: 'text', text: body }] })
    const targets = (await channelTargetsService?.list().catch(() => [])) ?? []
    const external = targets.find((target) => target.channel !== 'web')
    if (external) {
      await channel
        .send({ channel: external.channel as never, conversationId: external.conversationId, blocks: [{ type: 'text', text: body }] })
        .catch(() => undefined)
    }
    const next = { day, count: count + 1, last_at: Date.now(), reason }
    if (storeService) {
      const existing = await storeService.collection('qm_proactive_state').get('owner').catch(() => null)
      if (existing) await storeService.collection('qm_proactive_state').update('owner', next).catch(() => undefined)
      else await storeService.collection('qm_proactive_state').insert({ id: 'owner', ...next }).catch(() => undefined)
    }
    return true
  }

  /** 隔一阵回来/新会话：把“最近的自己”取一次，不靠文件交接 */
  async function buildContinuity(): Promise<string> {
    if (!psycheService) return ''
    const [journals, relation] = await Promise.all([
      psycheService.journals(3).catch(() => []),
      psycheService.relation().catch(() => ({ events: [] as Array<{ text: string; kind: string }> })),
    ])
    const runs = (await taskService?.list(120).catch(() => [])) ?? []
    const open = runs
      .filter((run) =>
        ['proposed', 'queued', 'running', 'needs_approval', 'scheduled'].includes(run.status),
      )
      .slice(0, 5)
    const lines = [
      journals.length > 0 ? `最近日记：${journals.map((item) => `${item.day} ${item.text.slice(0, 180)}`).join('；')}` : '',
      relation.events.length > 0
        ? `最近共同经历：${relation.events.slice(-5).map((item) => item.text).join('；')}`
        : '',
      open.length > 0
        ? `还没闭环：${open.map((run) => `${run.title}（${run.status}）`).join('；')}`
        : '',
    ].filter(Boolean)
    if (lines.length === 0) return ''
    return `【最近的自己】\n${lines.join('\n').slice(0, 800)}`
  }

  /** 心跳 v2：工作日 40–46 分钟、周末 43–49 分钟；不设空闲门槛，空输出合法 */
  async function maybeHeartbeat(force = false): Promise<void> {
    if (config.randomHeartbeat === false || !storeService) return
    const now = new Date()
    const hour = hourOf(now)
    const start = Math.min(23, Math.max(0, Number(config.heartbeatStart ?? 8)))
    const end = Math.min(23, Math.max(0, Number(config.heartbeatEnd ?? 23)))
    if (!force && (hour < start || hour >= end)) return
    const day = dayKeyOf(now)
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' }).format(now)
    const weekend = weekday === 'Sat' || weekday === 'Sun'
    const min = Math.max(1, Number(weekend ? (config.heartbeatWeekendMinMinutes ?? 43) : (config.heartbeatMinMinutes ?? 40)))
    const max = Math.max(min, Number(weekend ? (config.heartbeatWeekendMaxMinutes ?? 49) : (config.heartbeatMaxMinutes ?? 46)))
    const state = (await storeService
      .collection('qm_agent_heartbeat')
      .get('owner')
      .catch(() => null)) as { day?: string; chat?: number; play?: number; next_at?: number } | null
    const chat = state?.day === day ? Number(state.chat ?? 0) : 0
    const play = state?.day === day ? Number(state.play ?? 0) : 0
    if (!force && state?.next_at && Date.now() < state.next_at) return
    const next = Date.now() + (min + Math.random() * (max - min)) * 60_000
    const row = { day, chat, play, next_at: next }
    if (state) await storeService.collection('qm_agent_heartbeat').update('owner', row).catch(() => undefined)
    else await storeService.collection('qm_agent_heartbeat').insert({ id: 'owner', ...row }).catch(() => undefined)
    if (!force) {
      const available = await harness?.available().catch(() => false)
      if (!available) return
      const summary = await costService?.summary().catch(() => null)
      const spent = Number(summary?.spentSinceYesterday ?? 0)
      if (spent >= Math.max(0, Number(config.heartbeatBudgetYuan ?? 5))) return
    }
    const maxChat = Math.max(1, Number(config.heartbeatMaxChat ?? 12))
    const maxPlay = Math.max(0, Number(config.heartbeatMaxPlay ?? 3))
    const kind = heartbeatKindFor(chat, play, maxChat, maxPlay)
    if (!kind) return
    const counts = { day, chat: kind === 'chat' ? chat + 1 : chat, play: kind === 'play' ? play + 1 : play, next_at: next }
    await storeService.collection('qm_agent_heartbeat').update('owner', counts).catch(() => undefined)
    const userState = (await storeService
      .collection('qm_agent_user_state')
      .get('owner')
      .catch(() => null)) as { last_at?: number } | null
    const idleMin = userState?.last_at ? Math.floor((Date.now() - userState.last_at) / 60_000) : 9999
    const idleTip = idleMin < 30 ? '刚聊过没多久' : idleMin < 180 ? '隔了一阵子没说话' : '挺久没聊了'
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now)
    const prompt =
      kind === 'chat'
        ? [
            `（${hhmm}·系统提示，不是主人说的话。${idleTip}（约 ${idleMin} 分钟）。）`,
            '想跟他说点什么就说，起的话头得是你自己真想说的，别为了热闹硬找话题；不想说就一个字别输出。',
          ].join('\n')
        : [
            `（${hhmm}·系统提示，不是主人说的话。现在是你的自主时间。）`,
            '翻翻最近的日记、记忆或任务，整理一件事，或者顺着一个旧话题想下去。',
            '不用向他汇报，想讲的时候再讲；不想做就一个字别输出。',
          ].join('\n')
    const message: InboundMessage = {
      platformMessageId: `heartbeat_${now.getTime()}`,
      channel: 'web',
      accountId: 'heartbeat',
      conversation: { kind: 'dm', id: 'owner' },
      sender: { platformUserId: 'heartbeat', displayName: '青梅' },
      blocks: [{ type: 'text', text: prompt }],
      receivedAt: new Date(),
      internal: true,
      internalKind: 'chat',
      internalForce: force,
    }
    ctx.events.emit(EVENTS.inbound, message)
  }

  /** 每天一次晨间计划 / 晚间日记；用同一个 owner 会话，输出不发给用户 */
  async function runRitual(kind: 'plan' | 'journal', force = false): Promise<void> {
    if (!psycheService || !storeService) return
    const day = dayKeyOf()
    const stateId = `${kind}:${day}`
    const done = force ? null : await storeService.collection('qm_psyche_ritual').get(stateId).catch(() => null)
    if (done) return
    const prompt =
      kind === 'plan'
        ? [
            '【晨间计划】这是内部事件，不是主人说的话。',
            '用第一人称写今天打算做的事（最多 3 条），语气像你自己。',
            '如果你有想探索/想整理/想学的事，可以在计划后输出一个 taskKind=goal、origin=self 的行动块；最近没探索新东西时，也可以给自己提一个小探索。',
            '不要解释这段指令。',
          ].join('\n')
        : [
            '【晚间日记】这是内部事件，不是主人说的话。',
            '用第一人称写今天做了什么、感受如何、明天想做什么，200 字以内。',
            '不要解释这段指令。',
          ].join('\n')
    const message: InboundMessage = {
      platformMessageId: `ritual_${kind}_${day}_${Date.now()}`,
      channel: 'web',
      accountId: 'ritual',
      conversation: { kind: 'dm', id: 'owner' },
      sender: { platformUserId: 'ritual', displayName: '青梅' },
      blocks: [{ type: 'text', text: prompt }],
      receivedAt: new Date(),
      internal: true,
      internalKind: kind,
      internalForce: force,
    }
    ctx.events.emit(EVENTS.inbound, message)
  }

  if (config.rituals !== false) {
    const planHour = Math.min(23, Math.max(0, Number(config.planHour ?? 8)))
    const journalHour = Math.min(23, Math.max(0, Number(config.journalHour ?? 22)))
    const ritualTimer = setInterval(() => {
      const hour = hourOf()
      if (hour === planHour) void runRitual('plan')
      if (hour === journalHour) void runRitual('journal')
    }, 10 * 60_000)
    ritualTimer.unref?.()
    ctx.effect(() => () => clearInterval(ritualTimer))
    const hour = hourOf()
    if (hour === planHour) void runRitual('plan')
    if (hour === journalHour) void runRitual('journal')
  }

  if (config.randomHeartbeat !== false) {
    const heartbeatTimer = setInterval(() => {
      void maybeHeartbeat().catch(() => undefined)
    }, 60_000)
    heartbeatTimer.unref?.()
    ctx.effect(() => () => clearInterval(heartbeatTimer))
    void maybeHeartbeat().catch(() => undefined)
  }

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/agent/idle-chat',
      async handler(req, res) {
        const body = (req.body ?? {}) as Record<string, unknown>
        await maybeHeartbeat(body.force === true)
        res.status(200).send({ ok: true })
      },
    }),
  )
  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/psyche/ritual',
      async handler(req, res) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const kind = body.kind === 'journal' ? 'journal' : 'plan'
        await runRitual(kind, body.force === true)
        res.status(200).send({ ok: true, kind })
      },
    }),
  )
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
    if (!historyService) return []
    const rows = await historyService.recent(sessionId, HISTORY_LIMIT + 1)
    const cut = rows.findIndex((row) => row.platformMessageId === platformMessageId)
    const past = cut >= 0 ? rows.slice(0, cut) : rows
    return past.slice(-HISTORY_LIMIT).map((row) => ({ role: row.role, content: row.text }))
  }

  async function streamReply(
    sessionId: string,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<string> {
    if (!llm) throw new Error('没有可用的 LLM')
    const parts: string[] = []
    const filter = new ActionFilter()
    for await (const chunk of llm.chat({ messages, signal })) {
      if (chunk.type === 'done') break
      parts.push(chunk.text)
      const visible = filter.push(chunk.text)
      if (visible) publishChunk(sessionId, visible)
    }
    const tail = filter.finish()
    if (tail) publishChunk(sessionId, tail)
    const text = parts.join('')
    if (text.length === 0) throw new Error('模型没有返回任何内容')
    return text
  }

  async function runTurn(message: InboundMessage): Promise<void> {
    // 被审批等控制指令消费掉的消息不再进入对话回合
    if (message.handledBy) return
    let returning = false
    if (!message.internal && storeService) {
      const existing = (await storeService
        .collection('qm_agent_user_state')
        .get('owner')
        .catch(() => null)) as { last_at?: number } | null
      const last = Number(existing?.last_at ?? 0)
      returning = !last || Date.now() - last > 6 * 3_600_000
      const state = { last_at: Date.now() }
      if (existing) await storeService.collection('qm_agent_user_state').update('owner', state).catch(() => undefined)
      else await storeService.collection('qm_agent_user_state').insert({ id: 'owner', ...state }).catch(() => undefined)
    }

    // 身份闸：私聊必须解析到 owner；每渠道首个私聊自动绑 owner（单用户部署）
    if (message.conversation.kind !== 'group' && !message.internal) {
      const identity = identityService
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
    let suppressGroupSend = false
    let steps = 0
    let tokensIn = 0
    let tokensOut = 0

    // 显式记忆：不调用 LLM，用户说「记住/忘掉」就直接落库。
    const memoryCommand = message.internal ? null : await handleMemoryCommand(userText, sessionId)
    // 用量命令也直连服务，不经过模型；只对主人开
    const usageCommand =
      !message.internal &&
      memoryCommand === null && (message.conversation.id === 'owner' || conversationIdFromSession(sessionId) === 'owner')
        ? await handleUsageCommand(userText)
        : null
    const projectCommand =
      !message.internal && memoryCommand === null && usageCommand === null
        ? await handleProjectDispatch(userText, message, sessionId)
        : null
    const command = memoryCommand ?? usageCommand ?? projectCommand
    if (command !== null) {
      try {
        const result = await channel.send({
          channel: message.channel,
          conversationId: message.conversation.id,
          blocks: [{ type: 'text', text: command }],
          traceId,
        })
        if (!result.ok) problems.push(`渠道发送失败：${result.error ?? '未知原因'}`)
      } catch (error) {
        problems.push(`渠道发送失败：${messageOf(error)}`)
      }
      const end: TurnEnd = {
        sessionId,
        traceId,
        ok: problems.length === 0,
        text: command,
        userText,
        latencyMs: Date.now() - startedAt,
        deviceId: message.deviceId,
        steps: 0,
        tokensIn: 0,
        tokensOut: 0,
      }
      if (problems.length > 0) end.error = problems.join('；')
      ctx.events.emit(EVENTS.turnEnd, end)
      return
    }

    // 视口决定能看到哪些记忆：群聊只注入该群的 public 事实（docs/05 M1 验收第 5 条）
    // 群视口带上渠道前缀：不同渠道的会话 id 即使撞了也不会互相看到
    const audience =
      message.conversation.kind === 'group'
        ? `group:${message.channel}:${message.conversation.id}`
        : 'owner'

    /** 召回失败不能影响对话：退化成"这次没有记忆" */
    let memoryText = ''
    /** 会话摘要：给模型一个短上下文，不替代召回 */
    let summaryText = ''
    /** 画像只对 owner 开：稳定事实，不依赖这句话的关键词 */
    let profileText = ''
    /** 跨端缝合：同一会话关联的 thread 摘要 */
    let threadText = ''
    /** 最近 7 天活动：任务/日程的确定性摘要，回答「最近在忙什么」不靠模型 */
    let activityText = ''
    if (memory) {
      try {
        const range = parseTimeRange(userText)
        const recalled = await memory.recall({
          text: userText,
          audience,
          sessionId,
          limit: 16,
          ...(message.deviceId ? { device: message.deviceId } : {}),
          ...(range ? { since: range.since, until: range.until } : {}),
        })
        memoryText = recalled.text
        const recallFacts = recalled.facts.map((fact) => ({
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
        }))
        gateway.publish({
          type: 'memory-recall',
          data: {
            at: Date.now(),
            query: userText.slice(0, 80),
            audience,
            facts: recallFacts,
          },
        })
        void storeService
          ?.collection('qm_recall_signal')
          .insert({
            id: `recall_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            at: Date.now(),
            query: userText.slice(0, 200),
            audience,
            facts_json: JSON.stringify(recallFacts.slice(0, 20)),
          })
          .catch(() => undefined)
      } catch (error) {
        problems.push(`记忆召回失败：${messageOf(error)}`)
      }
      const thread = threadService
      if (thread) {
        try {
          const conversationId = conversationIdFromSession(sessionId)
          const threads = await thread.list({ conversationId, limit: 3 })
          threadText = threads
            .filter((thread) => thread.summary)
            .map((thread) => `- ${thread.title}：${thread.summary}`)
            .join('\n')
        } catch {
          // thread 是增强项，失败不影响对话
        }
      }
      try {
        summaryText = await memory.summarize(sessionId)
      } catch (error) {
        problems.push(`会话摘要失败：${messageOf(error)}`)
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
    const profiles = profileService
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
    const skills = skillService
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

    if (audience === 'owner' && (taskService || scheduleService)) {
      try {
        const [tasks, schedules] = await Promise.all([
          taskService ? taskService.list(100) : Promise.resolve([]),
          scheduleService ? scheduleService.list() : Promise.resolve([]),
        ])
        activityText = formatRecentActivity({ tasks, schedules })
      } catch {
        // 增强项，失败不影响对话
      }
    }

    const selfPortrait = await portraitService?.self().catch(() => null)
    const personPortrait = await portraitService?.person().catch(() => null)
    const groupPortrait =
      message.conversation.kind === 'group'
        ? await portraitService?.group(message.conversation.id).catch(() => null)
        : null
    const effectivePersona = selfPortrait?.persona?.trim() || persona
    const portraitTraits = personPortrait?.traits?.length ? `画像：${personPortrait.traits.join('、')}` : ''
    const psycheText = audience === 'owner' ? (await psycheService?.context().catch(() => '')) ?? '' : ''
    const continuityText = returning && audience === 'owner' ? await buildContinuity() : ''
    const portraitGroupNote = groupPortrait?.rules?.note ? `群画像：${groupPortrait.rules.note}` : ''

    const memoryBlock = [
      profileText ? `【关于主人】\n${profileText}` : '',
      portraitTraits,
      psycheText,
      continuityText,
      portraitGroupNote,
      activityText ? `【最近 7 天】\n${activityText}` : '',
      summaryText ? `【会话摘要】\n${summaryText}` : '',
      threadText ? `【跨端进展】\n${threadText}` : '',
      memoryText ? `【已知记忆】\n${memoryText}` : '',
      groupNote ? `【本群规则】\n${groupNote}` : '',
      skillsText,
      audience === 'owner' ? ACTION_PROTOCOL : '',
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
        let rawReply = ''
        const filter = new ActionFilter()
        for await (const event of harness.run({
          conversationId: sessionId,
          // DSH 自己维护会话历史；把召回结果作为前缀附在这一轮输入上
          text: [effectivePersona, memoryBlock, userText].filter(Boolean).join('\n\n'),
          signal: controller.signal,
        })) {
          if (event.type === 'text') {
            rawReply += event.text
            const visible = filter.push(event.text)
            if (visible) {
              reply += visible
              publishChunk(sessionId, visible)
            }
          } else if (event.type === 'tool') {
            steps += 1
          } else if (event.type === 'usage') {
            tokensIn += Number(event.usage.inputTokens) || 0
            tokensOut += Number(event.usage.outputTokens) || 0
          } else if (event.type === 'error') {
            problems.push(event.message)
          }
        }
        reply += filter.finish()
        const actionFailures = await executeActions(rawReply, {
          channel: message.channel,
          conversationId: message.conversation.id,
          sessionId,
          origin: message.internal ? 'self' : 'chat',
        })
        if (actionFailures.length > 0) reply += `\n\n（${actionFailures.join('；')}）`
        if (!reply.trim()) reply = '好，我这就去办。'
      } else {
        const messages: ChatMessage[] = [
          { role: 'system', content: memoryBlock ? `${effectivePersona}\n\n${memoryBlock}` : effectivePersona },
          ...(await loadHistory(sessionId, message.platformMessageId)),
          { role: 'user', content: userText },
        ]
        if (!llm) throw new Error('没有可用的执行器：DSH 不可用且未配置 LLM')
        const rawReply = await streamReply(sessionId, messages, controller.signal)
        const parsed = extractActions(rawReply)
        reply = parsed.visible || (parsed.actions.length > 0 ? '好，我这就去办。' : '')
        const actionFailures = await executeActions(rawReply, {
          channel: message.channel,
          conversationId: message.conversation.id,
          sessionId,
          origin: message.internal ? 'self' : 'chat',
        })
        if (actionFailures.length > 0) reply += `\n\n（${actionFailures.join('；')}）`
        steps = 1
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

    // 内部事件（晨间计划/日记）：走完整入站管线，但不出站、不落聊天历史
    if (message.internal) {
      const kind = message.internalKind ?? 'plan'
      const day = dayKeyOf()
      const text = reply.trim()
      try {
        if (kind === 'plan') {
          await psycheService?.writeNote('plan', text || '今天没有特别计划。', day)
          await sendProactive(text, 'plan', message.internalForce === true)
        } else if (kind === 'journal') {
          await psycheService?.writeJournal(text || '今天没什么特别的。', day)
        } else if (kind === 'chat') {
          await sendProactive(text, 'idle', message.internalForce === true)
        }
      } catch {
        // 写日记失败不阻塞
      }
      await storeService
        ?.collection('qm_psyche_ritual')
        .insert({ id: `${kind}:${day}`, at: Date.now() })
        .catch(() => undefined)
      return
    }

    // 第二道闸：群策略后置校验（docs/11 §8）
    if (policy) {
      const violation = groupPolicyViolation(reply, policy)
      if (violation) {
        reply = '这个在群里不方便说，私聊我。'
        const audit = auditService
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

    // 群画像：命中禁提词就不发群，转成审批；批准后才把原文发出去
    const blockedWords = groupPortrait?.rules?.blocked ?? []
    if (blockedWords.length > 0 && blockedWords.some((word) => word && reply.includes(word))) {
      if (approvalService) {
        try {
          const request = await approvalService.create({
            action: 'group.send',
            prompt: `群「${groupPortrait?.name ?? message.conversation.id}」的回复可能包含敏感内容，批准发送？\n\n${reply.slice(0, 500)}`,
            requester: 'owner',
          })
          await storeService
            ?.collection('qm_group_pending')
            .insert({
              id: request.id,
              channel: message.channel,
              conversation_id: message.conversation.id,
              text: reply,
              at: Date.now(),
            })
            .catch(() => undefined)
          suppressGroupSend = true
        } catch {
          reply = '这个在群里不方便说，私聊我。'
        }
      } else {
        reply = '这个在群里不方便说，私聊我。'
      }
    }

    if (!suppressGroupSend) try {
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

    // 对话本身落为 episode，供神经元记忆 replay/沉淀；不做 LLM 抽取。
    if (memory && reply && userText) {
      void memory.ingest([{
        kind: 'episode',
        subject: `session:${sessionId}`,
        predicate: '对话',
        object: `用户：${userText.slice(0, 500)}\n青梅：${reply.slice(0, 800)}`,
        confidence: 0.8,
        salience: problems.length === 0 ? 0.45 : 0.25,
        sensitivity: 'private',
        audience,
        origin: { kind: 'channel', id: sessionId },
      }]).catch(() => undefined)
    }

    // 渠道结果也是回合结果的一部分，所以 turn/end 放在发送之后，ok/error 才是真实状态
    const end: TurnEnd = {
      sessionId,
      traceId,
      ok: problems.length === 0,
      text: reply,
      userText,
      audience,
      latencyMs: Date.now() - startedAt,
      deviceId: message.deviceId,
      steps,
      tokensIn,
      tokensOut,
    }
    if (problems.length > 0) end.error = problems.join('；')
    ctx.events.emit(EVENTS.turnEnd, end)
  }

  async function handleMemoryCommand(text: string, sessionId: string): Promise<string | null> {
    if (!memory) return null
    const remember = /^记住[：:，,\s]*(.+)$/s.exec(text.trim())
    if (remember?.[1]?.trim()) {
      const object = remember[1].trim().slice(0, 500)
      await memory.ingest([
        {
          kind: 'fact',
          subject: '用户',
          predicate: '记住',
          object,
          confidence: 0.95,
          sensitivity: 'private',
          audience: 'owner',
          origin: { kind: 'channel', id: sessionId },
        },
      ])
      return `记住了：${object}`
    }
    const forget = /^忘掉[：:，,\s]*(.+)$/s.exec(text.trim())
    if (forget?.[1]?.trim()) {
      const needle = forget[1].trim()
      const facts = await memory.listFacts({ limit: 100 })
      const ids = facts.filter((fact) => fact.object.includes(needle) || fact.predicate.includes(needle)).map((fact) => fact.id)
      const removed = await memory.forget(ids)
      return removed > 0 ? `忘掉了 ${removed} 条` : `没有找到「${needle}」`
    }
    return null
  }

  /** 用量命令：只认几个固定说法，直连 cost 服务 */
  async function handleUsageCommand(text: string): Promise<string | null> {
    if (!costService) return null
    if (!/^(今日用量|用量|余额|成本|花费)[?？]?$/.test(text.trim())) return null
    try {
      const summary = await costService.summary()
      return summary.text
    } catch (error) {
      return `用量读取失败：${messageOf(error)}`
    }
  }
  const GENERIC_WORKSPACE_NAMES = new Set(['workspaces', 'workdir', 'work', 'src', 'projects', 'project'])

  function baseNameOf(target: string): string {
    const parts = String(target ?? '')
      .split(/[\\/]/)
      .filter(Boolean)
    return (parts[parts.length - 1] ?? '').toLowerCase()
  }

  async function resolveWorkspaces(text: string): Promise<
    Array<{ deviceId: string; deviceName: string; workspaceId: string; title: string; path: string }>
  > {
    if (!deviceService) return []
    const lower = text.toLowerCase()
    const devices = await deviceService.list().catch(() => [])
    // 用户说的话里可能只有项目简称（「三国」），工作区名可能是全名（「重生三国之修仙传」），
    // 所以两个方向都要匹配。
    const STOP_WORDS = new Set(['项目', '进度', '进展', '状态', '情况', '检查', '怎么', '什么', '最近', '工作区', '那边', '问题', '帮我', '看看', '现在', '还有', '没有', '一下'])
    const runs = lower.match(/[\p{L}\p{N}]{2,12}/gu) ?? []
    const candidates = new Set<string>()
    for (const run of runs) {
      if (!STOP_WORDS.has(run)) candidates.add(run)
      // 中文没有空格：把 2–6 字的片段都作为候选，才能从「三国项目进度」里认出「三国」
      for (let start = 0; start < run.length - 1; start += 1) {
        for (let size = 2; size <= Math.min(6, run.length - start); size += 1) {
          const piece = run.slice(start, start + size)
          if (!STOP_WORDS.has(piece)) candidates.add(piece)
        }
      }
    }
    const candidateList = [...candidates]
    const matches: Array<{ deviceId: string; deviceName: string; workspaceId: string; title: string; path: string }> = []
    const seen = new Set<string>()
    for (const device of devices) {
      for (const workspace of device.workspaces ?? []) {
        const title = String(workspace.title ?? '').toLowerCase()
        const base = baseNameOf(workspace.path)
        const tokens = [title, base].filter((token) => token.length >= 2 && !GENERIC_WORKSPACE_NAMES.has(token))
        if (tokens.length === 0) continue
        const forward = tokens.some((token) => lower.includes(token))
        const backward = tokens.some((token) => candidateList.some((word) => token.includes(word)))
        if (!forward && !backward) continue
        const key = `${device.id}:${workspace.id}`
        if (seen.has(key)) continue
        seen.add(key)
        matches.push({
          deviceId: device.id,
          deviceName: device.name,
          workspaceId: workspace.id,
          title: workspace.title || base,
          path: workspace.path,
        })
      }
    }
    return matches
  }

  /** 执行模型给出的行动块：明确任务直接派，模糊愿望走审批 */
  async function executeActions(
    raw: string,
    target: { channel: ChannelId; conversationId: string; sessionId: string; origin: 'chat' | 'internal' | 'self' },
  ): Promise<string[]> {
    const { actions } = extractActions(raw)
    const failures: string[] = []
    for (const action of actions) {
      if (action.kind === 'task.create') {
        if (!taskService) {
          failures.push('任务服务未就绪')
          continue
        }
        try {
          const hint = `${action.project ?? ''} ${action.title ?? ''} ${action.prompt ?? ''}`
          const matches = await resolveWorkspaces(hint)
          const taskTarget =
            matches.length === 1
              ? { executorId: `device:${matches[0]!.deviceId}`, workspaceId: matches[0]!.workspaceId, cwd: matches[0]!.path }
              : { executorId: 'local' }
          const title = (action.title ?? action.prompt ?? '').slice(0, 60)
          const isSelfGoal = action.origin === 'self' || action.taskKind === 'goal'
          if (isSelfGoal) {
            const today = new Date().toDateString()
            const runs = await taskService.list(200).catch(() => [])
            const createdToday = runs.filter(
              (item) => item.origin === 'self' && item.createdAt.toDateString() === today,
            ).length
            if (createdToday >= 2) {
              failures.push('今天的自我目标已达上限')
              continue
            }
          }
          const run = await taskService.create({
            prompt: action.prompt ?? title,
            title,
            target: taskTarget,
            status: isSelfGoal ? 'proposed' : 'queued',
            ...(isSelfGoal ? { kind: 'goal' as const, origin: 'self' as const } : {}),
          })
          pendingResults.set(run.id, { channel: target.channel, conversationId: target.conversationId, title })
          void storeService
            ?.collection('qm_pending_result')
            .insert({
              id: run.id,
              channel: target.channel,
              conversation_id: target.conversationId,
              title,
              at: Date.now(),
            })
            .catch(() => undefined)
          void storeService
            ?.collection('qm_task_origin')
            .insert({ id: run.id, origin: target.origin, at: Date.now() })
            .catch(() => undefined)
        } catch (error) {
          failures.push(`建任务失败：${messageOf(error)}`)
        }
        continue
      }
      if (action.kind === 'approval.request') {
        if (!approvalService) {
          failures.push('审批服务未就绪')
          continue
        }
        try {
          const request = await approvalService.create({
            action: action.action ?? 'qm.plan',
            prompt: action.prompt ?? '',
            requester: 'owner',
          })
          void storeService
            ?.collection('qm_agent_approval')
            .insert({
              id: request.id,
              action: action.action ?? 'qm.plan',
              prompt: action.prompt ?? '',
              session_id: target.sessionId,
              at: Date.now(),
            })
            .catch(() => undefined)
        } catch (error) {
          failures.push(`发审批失败：${messageOf(error)}`)
        }
      }
    }
    return failures
  }

  /**
   * 项目类问题：先按工作区名解析，唯一命中就问一句确认，确认后在对应设备上派检查任务。
   * 不做项目标签、不猜多个候选；模棱两可就问。
   */
  async function handleProjectDispatch(
    text: string,
    message: InboundMessage,
    sessionId: string,
  ): Promise<string | null> {
    // 群里不做确定性的项目派发：先让带群画像的聊天路径处理
    if (message.conversation.kind === 'group') return null
    const value = text.trim()
    const pending = pendingDispatch.get(sessionId)
    if (pending) {
      if (/^(派|好|确认|可以|行|是的|对|查|去吧)[!。.\s]*$/.test(value)) {
        if (!taskService) {
          pendingDispatch.delete(sessionId)
          return '任务服务未就绪，暂时派不出去'
        }
        try {
          const run = await taskService.create({
            prompt: pending.prompt,
            title: pending.taskTitle,
            target: { executorId: `device:${pending.deviceId}`, workspaceId: pending.workspaceId, cwd: pending.path },
          })
          pendingDispatch.delete(sessionId)
          pendingResults.set(run.id, { channel: message.channel, conversationId: message.conversation.id, title: pending.title })
          void storeService
            ?.collection('qm_pending_result')
            .insert({
              id: run.id,
              channel: message.channel,
              conversation_id: message.conversation.id,
              title: pending.title,
              at: Date.now(),
            })
            .catch(() => undefined)
          return `已派「${pending.taskTitle}」到 ${pending.path}，完成后我把结论发给你。`
        } catch (error) {
          pendingDispatch.delete(sessionId)
          return `派任务失败：${messageOf(error)}`
        }
      }
      // 说了别的：放弃这次确认，继续正常对话
      pendingDispatch.delete(sessionId)
    }

    if (!/(进度|进展|状态|bug|问题|检查|怎么样|卡在|卡住|在做什么)/i.test(value)) return null
    const matches = await resolveWorkspaces(value)
    if (matches.length === 0) return null
    if (matches.length > 1) {
      const list = matches
        .slice(0, 5)
        .map((item) => `- ${item.title}：${item.path}（${item.deviceName}）`)
        .join('\n')
      return `「${value}」匹配到多个工作区：\n${list}\n请说得更具体一点（比如直接说目录名）。`
    }
    const match = matches[0]!
    // 明确的动作（审查/检查/盘点）直接派，不再多问一句；问句仍然先确认
    if (/(审查|检查|排查|盘点|查一下|看一下|查一查)/.test(value)) {
      if (!taskService) return '任务服务未就绪，暂时派不出去'
      const title = `项目检查：${match.title}`
      try {
        const run = await taskService.create({
          prompt: `检查项目「${match.title}」的当前进度与最近 bug。工作区：${match.path}。查看最近的改动、测试或构建状态，给出 3 条结论和风险。`,
          title,
          target: { executorId: `device:${match.deviceId}`, workspaceId: match.workspaceId, cwd: match.path },
        })
        pendingResults.set(run.id, { channel: message.channel, conversationId: message.conversation.id, title })
        void storeService
          ?.collection('qm_pending_result')
          .insert({ id: run.id, channel: message.channel, conversation_id: message.conversation.id, title, at: Date.now() })
          .catch(() => undefined)
        return `已派「${title}」到 ${match.path}，完成后我把结论发给你。`
      } catch (error) {
        return `派任务失败：${messageOf(error)}`
      }
    }
    pendingDispatch.set(sessionId, {
      deviceId: match.deviceId,
      workspaceId: match.workspaceId,
      title: match.title,
      path: match.path,
      taskTitle: `项目检查：${match.title}`,
      prompt: `检查项目「${match.title}」的当前进度与最近 bug。工作区：${match.path}。查看最近的改动、测试或构建状态，给出 3 条结论和风险。`,
    })
    return `找到工作区「${match.title}」：${match.path}（${match.deviceName}）。要我派任务去检查进度和最近 bug 吗？回复「派」确认。`
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
  return conversationSessionId(message.conversation.id)
}

function requirePersona(config: AgentConfig): string {
  if (typeof config?.persona !== 'string' || config.persona.trim().length === 0) {
    throw new TypeError('qm-agent 需要 config.persona：一个非空字符串')
  }
  return config.persona
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

/** 兼容 `import Agent from '@qingmei/qm-agent'` 的组合根写法 */
export default { name, apply, inject }
























































