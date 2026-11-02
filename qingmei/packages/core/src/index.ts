/**
 * @qingmei/core —— P1 契约层。
 *
 * 这里只放：协议类型、事件名、服务的抽象类。
 * 不放任何实现，也不认识任何具体渠道/模型/存储。
 */
import { Service, type Context } from 'cordis'

export { nextCronTime, parseCron, systemTimeZone, type CronSpec } from './cron.ts'

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

/** qm/outbound 的载荷：投递成功的出站消息 */
export interface OutboundRecord extends OutboundEnvelope {
  platformMessageId?: string
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
  /** 回合真正开始处理某条入站消息（排队轮到它时） */
  turnStart: 'qm/turn/start',
  /** 渠道发送成功后发出：落库、审计等收尾动作订阅它 */
  outbound: 'qm/outbound',
  turnRequest: 'qm/turn/request',
  turnChunk: 'qm/turn/chunk',
  turnEnd: 'qm/turn/end',
  channelOnline: 'qm/channel/online',
  channelOffline: 'qm/channel/offline',
  scheduleDue: 'qm/schedule/due',
  taskRunStarted: 'qm/task/run-started',
  taskProgress: 'qm/task/progress',
  taskFinished: 'qm/task/finished',
  approvalRequested: 'qm/approval/requested',
  approvalDecided: 'qm/approval/decided',
  /** 自主循环每跑完一次（无论是否给出建议） */
  autonomyTick: 'qm/autonomy/tick',
} as const

// ────────────────────────────────────────────── 日程

/** 停机期间错过多次时的处理方式：补发一次（默认）或跳过 */
export type MissedPolicy = 'fire-once' | 'skip'

export interface ScheduleInput {
  text: string
  /** 一次性：绝对时间。与 everyMs / cron 三选一 */
  at?: Date
  /** 固定间隔重复。与 at / cron 三选一 */
  everyMs?: number
  /** 五段式 cron：分 时 日 月 周。与 at / everyMs 三选一 */
  cron?: string
  /** IANA 时区，如 Asia/Shanghai；缺省用 provider 配置的默认时区（未配置时用进程时区）。仅 cron 有意义 */
  timezone?: string
  /** 停机期间错过多次时：补发一次（默认）或跳过。仅 cron 有意义 */
  missedPolicy?: MissedPolicy
  channel?: ChannelId
  conversationId?: string
}

export interface Scheduled {
  id: string
  text: string
  channel: ChannelId
  conversationId: string
  nextAt: Date
  everyMs: number | null
  /** 周期规则；一次性与固定间隔为 null */
  cron: string | null
  /** cron 使用的 IANA 时区；非 cron 为 null */
  timezone: string | null
  missedPolicy: MissedPolicy
  /** 暂停时刻；null 表示正常推进 */
  pausedAt: Date | null
  firedAt: Date | null
}

/** 日程参数不合法（内容为空、cron 写错、规则冲突…）。调用方应映射成 400 而不是 500 */
export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidScheduleError'
  }
}

/** 修改已有日程：给了规则字段就整体替换规则，并「从现在」重算下一次触发 */
export interface SchedulePatch {
  text?: string
  at?: Date
  everyMs?: number
  cron?: string
  timezone?: string
  missedPolicy?: MissedPolicy
}

export abstract class ScheduleService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'schedule')
  }
  abstract create(input: ScheduleInput): Promise<Scheduled>
  abstract list(): Promise<Scheduled[]>
  abstract cancel(id: string): Promise<boolean>
  /** 暂停：保留 nextAt，但到点不再触发。返回 false 表示没有这条日程 */
  abstract pause(id: string): Promise<boolean>
  /** 继续：周期日程从「现在」重排下一次；一次性日程保持原时间。返回 false 表示没有这条日程 */
  abstract resume(id: string): Promise<boolean>
  /** 改内容或规则；规则变了就从「现在」重排。返回 null 表示没有这条日程或它已经结束 */
  abstract update(id: string, patch: SchedulePatch): Promise<Scheduled | null>
}

// ────────────────────────────────────────────── 自主循环（docs/13，A1）

export interface AutonomyCandidate {
  /** 规则 id：冷却与去重按它 */
  id: string
  /** 行动白名单里的动作名，如 notify.self / task.retry */
  action: string
  title: string
  /** 为什么提这条（后台可读） */
  reason: string
  /** 排序用；规则给的确定性分值 */
  value: number
  risk: 'low' | 'medium' | 'high'
  payload?: Record<string, unknown>
}

export interface AutonomySnapshot {
  at: Date
  pendingApprovals: number
  runningTasks: number
  failedTasks: number
  upcomingSchedules: number
}

export type AutonomyLevel = 'A0' | 'A1' | 'A2' | 'A3'

/** 行动白名单：自主循环只能做这里登记过的动作（docs/13 §4） */
export interface AutonomyActionSpec {
  action: string
  risk: 'low' | 'medium' | 'high'
  /** 不可逆动作永远要人工确认，自主循环不执行 */
  reversible: boolean
  /** 最低可执行级别；低于它只能降级成建议 */
  minLevel: AutonomyLevel
  description: string
}

export const AUTONOMY_ACTIONS: Record<string, AutonomyActionSpec> = {
  'notify.self': {
    action: 'notify.self',
    risk: 'low',
    reversible: true,
    minLevel: 'A1',
    description: '给主人发一条消息（建议、提醒）',
  },
  'task.retry': {
    action: 'task.retry',
    risk: 'medium',
    reversible: true,
    minLevel: 'A2',
    description: '把失败的任务再派一次',
  },
  'harness.dispatch': {
    action: 'harness.dispatch',
    risk: 'medium',
    reversible: true,
    minLevel: 'A2',
    description: '派一个新任务给 harness',
  },
  'memory.consolidate': {
    action: 'memory.consolidate',
    risk: 'medium',
    reversible: true,
    minLevel: 'A2',
    description: '触发记忆整理（有快照可回滚）',
  },
  'env.cleanup': {
    action: 'env.cleanup',
    risk: 'medium',
    reversible: true,
    minLevel: 'A2',
    description: '清理缓存/日志/临时目录（进回收站）',
  },
  'outbound.send': {
    action: 'outbound.send',
    risk: 'high',
    reversible: false,
    minLevel: 'A3',
    description: '对外发消息——不可逆，永远人工',
  },
  'delete.permanent': {
    action: 'delete.permanent',
    risk: 'high',
    reversible: false,
    minLevel: 'A3',
    description: '永久删除数据——不可逆，永远人工',
  },
}

/** 一次 tick 对选中候选的实际处理结果；没有回执不算执行过 */
export interface AutonomyExecution {
  status: 'executed' | 'suggested' | 'skipped' | 'failed'
  action: string
  detail: string
  at: Date
  /** 派生出新任务时带上 runId */
  runId?: string
}

export interface AutonomyTrace {
  id: string
  at: Date
  trigger: 'tick' | 'manual'
  mode: AutonomyLevel
  snapshot: AutonomySnapshot
  candidates: AutonomyCandidate[]
  chosen: AutonomyCandidate | null
  /** 被过滤掉的候选与原因；「为什么没说」也要可查 */
  suppressed: { id: string; reason: string }[]
  budget: { day: string; limit: number; used: number }
  /** 选中之后做了什么（或为什么没做） */
  execution: AutonomyExecution | null
  /** 一句话结论：保持沉默时写清楚原因 */
  reason: string
}

export interface AutonomyState {
  mode: AutonomyLevel
  /** 预算按本地日期重置 */
  day: string
  used: number
  lastTickAt: Date | null
  /** 规则 id → 冷却截止时间戳 */
  cooldowns: Record<string, number>
  /** 建议被回应（采纳）的累计次数 */
  accepted: number
  /** 建议在窗口内没人理（忽略）的累计次数 */
  ignored: number
  /** 连续被回应、没有被打断的次数；信任升级看它 */
  streak: number
  /** 最近一条还等着被回应的建议 */
  pending: { traceId: string; candidateId: string; at: number; expiresAt: number } | null
  /** 规则 id → 被忽略的次数；达到阈值后冷却翻倍 */
  ignoredByRule: Record<string, number>
}

/** 自主循环：世界状态快照 → 候选 → 过滤 → 选择 → 记账（docs/13 §3） */
export abstract class AutonomyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'autonomy')
  }
  abstract tick(trigger: 'tick' | 'manual'): Promise<AutonomyTrace>
  abstract list(limit?: number): Promise<AutonomyTrace[]>
  abstract status(): Promise<AutonomyState>
}

export interface TurnRequest {
  sessionId: string
  inbound: InboundMessage
  history: ChatMessage[]
}

/** qm/turn/start 的载荷：某个回合开始处理这条消息 */
export interface TurnStart {
  sessionId: string
  message: InboundMessage
}

export interface TurnChunk {
  sessionId: string
  text: string
}

export interface TurnEnd {
  sessionId: string
  ok: boolean
  text: string
  /** 本回合用户说了什么：记忆抽取要用，避免再查库 */
  userText?: string
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
  /** 会话建好后回调一次，用于把 harness 侧 sessionId 记进账本（resume 要用） */
  onSession?: (sessionId: string) => void
}

export type HarnessEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; status: string }
  | { type: 'usage'; usage: TaskUsage }
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

// ────────────────────────────────────────────── 记忆

export interface MemoryRecord {
  kind: 'fact' | 'episode'
  /** fact 用：主体 / 关系 / 客体 */
  subject: string
  predicate: string
  object: string
  /** 0..1 */
  confidence: number
  sensitivity: 'public' | 'private' | 'secret'
  /** 可见范围：'owner' 只给主人；'group:<id>' 群内可见。缺省 owner */
  audience?: string
  origin: { kind: 'channel' | 'harness' | 'self' | 'doc' | 'manual'; id: string }
  occurredAt?: Date
}

export interface RecalledFact extends MemoryRecord {
  id: string
  createdAt: Date
  /** 失效时间；召回只取 null 的 */
  validTo?: Date | null
}

export interface RecallQuery {
  text: string
  limit?: number
  /** 当前视口：'owner'（缺省）或 'group:<id>'；群聊只注入 public 且 audience 匹配的记忆 */
  audience?: string
}

export interface RecallResult {
  facts: RecalledFact[]
  /** 已格式化、可直接拼进 prompt 的文本；无命中时为空串 */
  text: string
}

export abstract class MemoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memory')
  }
  /** 幂等写入：完全相同的三元组只合并，不重复 */
  abstract ingest(records: MemoryRecord[]): Promise<{ created: string[]; merged: string[] }>
  abstract recall(query: RecallQuery): Promise<RecallResult>
  abstract forget(ids: string[]): Promise<number>
}

// ────────────────────────────────────────────── 任务账本

export type TaskStatus = 'queued' | 'running' | 'needs_approval' | 'done' | 'failed' | 'cancelled'

export interface TaskProgress {
  phase: string
  /** 0..100；模型给的百分比通常不准，只当参考 */
  percent?: number
  note?: string
  at: Date
}

/** 子 agent 交付的东西：先记引用（链接/路径），blob 存储留给后续 */
export interface TaskArtifact {
  name: string
  url?: string
  path?: string
  summary?: string
  at: Date
}

/** 一次 run 的 token 用量（ACP prompt 响应里的 usage，实验字段） */
export interface TaskUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/**
 * 一次执行（docs/07 §5）。
 *
 * `taskId` 是长期任务，`TaskRun` 是一次执行；两次重试/换 harness 是两个 run。
 * P1 一任务一 run，`taskId === id`。
 */
export interface TaskRun {
  id: string
  taskId: string
  title: string
  prompt: string
  /** 归属项目；老数据没有这一列，读取为 null */
  project: string | null
  kind: 'task' | 'inventory'
  harnessId: string
  /** harness 侧会话 id，用于 resume */
  sessionId: string | null
  /** 青梅分配的 run 目录，不是用户任意路径 */
  cwd: string
  status: TaskStatus
  progress: TaskProgress | null
  artifacts: TaskArtifact[]
  usage: TaskUsage | null
  result: string | null
  error: string | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

export interface CreateTaskInput {
  prompt: string
  title?: string
  /** 归属项目；项目审问按它过滤（docs/13 §7） */
  project?: string
  /** task = 正常任务；inventory = 只读盘点（结论要回推给主人） */
  kind?: 'task' | 'inventory'
  /** 不传则用 provider 的 workspaceRoot/<id> */
  cwd?: string
  harnessId?: string
}

export abstract class TaskService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'task')
  }
  abstract create(input: CreateTaskInput): Promise<TaskRun>
  abstract get(id: string): Promise<TaskRun | null>
  abstract list(limit?: number): Promise<TaskRun[]>
  /** queued|needs_approval → running */
  abstract start(id: string, patch?: { sessionId?: string }): Promise<TaskRun | null>
  /** running → needs_approval（等主人确认）或回到 running */
  abstract setStatus(id: string, status: 'running' | 'needs_approval'): Promise<TaskRun | null>
  abstract reportProgress(
    id: string,
    progress: { phase: string; percent?: number; note?: string },
  ): Promise<TaskRun | null>
  /** 追加一个产物（链接/路径/摘要）；已结束的 run 返回 null */
  abstract addArtifact(
    id: string,
    artifact: { name: string; url?: string; path?: string; summary?: string },
  ): Promise<TaskRun | null>
  /** 记录 token 用量（一次 prompt 的 usage） */
  abstract reportUsage(id: string, usage: TaskUsage): Promise<TaskRun | null>
  /** 收尾；对已结束的 run 幂等返回当前值 */
  abstract finish(
    id: string,
    input: { status: 'done' | 'failed' | 'cancelled'; result?: string; error?: string },
  ): Promise<TaskRun | null>
}

/**
 * 把 run 交给 harness 去跑。派发是异步的：调用方拿回 run 就该返回，
 * 进度通过 `qm/task/*` 事件与账本查询。
 */
export abstract class TaskRunnerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'taskRunner')
  }
  abstract dispatch(run: TaskRun): void
}

// ────────────────────────────────────────────── 权限与审计

export interface Actor {
  id: string
  displayName: string
  role: 'owner' | 'family' | 'guest' | 'stranger'
}

export interface PermissionRequest {
  actor: Actor
  channel: ChannelId
  conversation: 'dm' | 'group'
  /** 'tool.invoke:<name>' | 'memory.read' | 'channel.send'… */
  action: string
  resource?: string
}

export type Decision =
  | { effect: 'allow' }
  | { effect: 'deny'; reason: string }
  | { effect: 'ask'; prompt: string }

/** 静态策略：动作前缀匹配（'tool.invoke:schedule_' 命中所有 schedule_*） */
export interface PolicyRule {
  match: string
  effect: 'allow' | 'deny' | 'ask'
  reason?: string
  prompt?: string
  conversation?: 'dm' | 'group'
  role?: Actor['role']
}

export abstract class PermissionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'permission')
  }
  abstract check(req: PermissionRequest): Promise<Decision>
  abstract rules(): PolicyRule[]
  /** 运行时追加规则；返回撤销函数 */
  abstract addRule(rule: PolicyRule): () => void
}

export interface AuditEntry {
  at: Date
  actorId: string
  channel: ChannelId
  action: string
  target?: string
  decision?: 'allow' | 'deny'
  /** 已脱敏；原始内容只存引用 */
  detail?: Record<string, unknown>
  traceId: string
}

/** 审计只追加：没有 update / delete */
export abstract class AuditService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'audit')
  }
  abstract append(entry: AuditEntry): Promise<void>
  abstract query(q: { since?: Date; actorId?: string; action?: string; limit?: number }): Promise<AuditEntry[]>
}

// ────────────────────────────────────────────── 审批

export type ApprovalStatus = 'pending' | 'allowed' | 'denied'

/** 一次待人确认的动作（docs/07 §8 的审批桥） */
export interface ApprovalRequest {
  id: string
  action: string
  prompt: string
  status: ApprovalStatus
  /** 关联的任务 run（子 agent 触发的审批），没有则为 null */
  runId: string | null
  requester: string
  channel: ChannelId
  createdAt: Date
  decidedAt: Date | null
  reason: string | null
}

export interface CreateApprovalInput {
  action: string
  prompt: string
  runId?: string
  requester?: string
  channel?: ChannelId
}

/** 审批队列：ask 的判定落到这里，人批准后调用方继续 */
export abstract class ApprovalService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'approval')
  }
  abstract create(input: CreateApprovalInput): Promise<ApprovalRequest>
  abstract get(id: string): Promise<ApprovalRequest | null>
  abstract list(status?: ApprovalStatus): Promise<ApprovalRequest[]>
  abstract decide(id: string, input: { allow: boolean; reason?: string }): Promise<ApprovalRequest | null>
  /** 等判定；超时或不存在返回 null（调用方按拒绝处理） */
  abstract wait(id: string, timeoutMs: number): Promise<ApprovalRequest | null>
}

// ────────────────────────────────────────────── MCP

/**
 * 把青梅自己的能力以 MCP 服务器形式暴露给外部 agent runtime。
 * harness 在 session/new 时读取 servers() 注入声明。
 */
export abstract class McpService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mcp')
  }
  /** ACP 的 mcpServers 数组，形如 [{type:'http',name,url,headers}] */
  abstract servers(): unknown[]
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
