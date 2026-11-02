/**
 * @qingmei/host-mcp —— 把青梅的能力以 MCP（Streamable HTTP）暴露给外部 agent。
 *
 * 只实现 MCP 的最小面：initialize / tools/list / tools/call。
 * 工具是「一份定义 + 一个 handler」的注册表（见 createTools）：
 * tools/list 与 tools/call 读同一份，新增工具只改一处。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import {
  McpService,
  uid,
  type Actor,
  type ApprovalService,
  type HarnessService,
  type AuditService,
  type ChannelId,
  type MemoryRecord,
  type MemoryService,
  type PermissionService,
  type Scheduled,
  type ScheduleInput,
  type SchedulePatch,
  type ScheduleService,
  type TaskRun,
  type TaskRunnerService,
  type TaskService,
} from '@qingmei/core'

export interface McpConfig {
  host?: string
  port?: number
  /** 简单 bearer 校验；DSH 通过 headers 带上 */
  token?: string
  path?: string
  /** 调用工具的 actor；P1 只有 owner 一个身份 */
  actorId?: string
  /** 工具调用发生的会话类型：群聊里策略会收紧 */
  conversation?: 'dm' | 'group'
  /** ask 时等主人确认的时长，默认 60s */
  approvalTimeoutMs?: number
}

export const name = 'host-mcp'
export const inject = ['memory', 'schedule', 'task', 'taskRunner', 'permission', 'audit', 'approval']

const PROTOCOL_VERSION = '2024-11-05'

/** 工具调用前的鉴权与留痕所需的一切 */
export interface ToolGuard {
  permission: PermissionService
  audit: AuditService
  /** ask 的确认队列；没有就按拒绝处理 */
  approval?: ApprovalService
  actor: Actor
  channel: ChannelId
  conversation: 'dm' | 'group'
  approvalTimeoutMs?: number
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000

/**
 * 工具调用的准入：permission → 审计 →（ask 时）等人批准 → 执行。
 *
 * 审计先写、再抛错：被拒绝的调用本身也是要留痕的事实。
 * `ask` 会落一条审批请求并阻塞等待；批准则继续，拒绝/超时按拒绝处理。
 */
export async function guardToolCall(guard: ToolGuard, toolName: string): Promise<void> {
  const action = `tool.invoke:${toolName}`
  const decision = await guard.permission.check({
    actor: guard.actor,
    channel: guard.channel,
    conversation: guard.conversation,
    action,
    resource: toolName,
  })

  if (decision.effect === 'deny') {
    await guard.audit.append({
      at: new Date(),
      actorId: guard.actor.id,
      channel: guard.channel,
      action,
      target: toolName,
      decision: 'deny',
      detail: { effect: 'deny', reason: decision.reason },
      traceId: uid('trace'),
    })
    throw new Error(`工具「${toolName}」被拒绝：${decision.reason}`)
  }

  if (decision.effect === 'allow') {
    await guard.audit.append({
      at: new Date(),
      actorId: guard.actor.id,
      channel: guard.channel,
      action,
      target: toolName,
      decision: 'allow',
      traceId: uid('trace'),
    })
    return
  }

  // effect === 'ask'：落审批，等人拍板
  const approval = guard.approval
    ? await guard.approval.create({
        action,
        prompt: decision.prompt,
        requester: 'tool:host-mcp',
        channel: guard.channel,
      })
    : null

  if (!approval) {
    await guard.audit.append({
      at: new Date(),
      actorId: guard.actor.id,
      channel: guard.channel,
      action,
      target: toolName,
      decision: 'deny',
      detail: { effect: 'ask', reason: '没有可用的审批队列' },
      traceId: uid('trace'),
    })
    throw new Error(`工具「${toolName}」需要主人确认，但没有可用的审批队列`)
  }

  const decided = await guard.approval!.wait(approval.id, guard.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS)
  // 超时也要落定，否则队列里会永远挂着一条 pending
  if (!decided) await guard.approval!.decide(approval.id, { allow: false, reason: '等待确认超时' })
  const allowed = decided?.status === 'allowed'
  await guard.audit.append({
    at: new Date(),
    actorId: guard.actor.id,
    channel: guard.channel,
    action,
    target: toolName,
    decision: allowed ? 'allow' : 'deny',
    detail: { effect: 'ask', approvalId: approval.id, status: decided?.status ?? 'timeout' },
    traceId: uid('trace'),
  })

  if (!allowed) {
    const why = decided?.status === 'denied' ? (decided.reason ?? '被拒绝') : '等待确认超时'
    throw new Error(`工具「${toolName}」未获批准：${why}`)
  }
}

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError: boolean
}

export interface HostTool {
  name: string
  description: string
  /** JSON Schema（MCP tools/list 直接透出） */
  inputSchema: Record<string, unknown>
  call(args: Record<string, unknown>): Promise<ToolResult>
}

export interface ToolDeps {
  memory: MemoryService
  schedule: ScheduleService
  task: TaskService
  runner: TaskRunnerService
  /** 有就用它判断能不能派人盘点；没有就只给账本快照 */
  harness?: HarnessService
}

/** 工具注册表：新增能力只在这里加一项，schema、描述、处理逻辑都在一处 */
export function createTools(deps: ToolDeps): HostTool[] {
  return [
    {
      name: 'memory_recall',
      description: '召回青梅记住的、与查询相关的事实。回答用户问题前应先查一次。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查询的内容，用用户的原话或关键词' },
          limit: { type: 'number', description: '最多返回几条，默认 5' },
        },
        required: ['query'],
      },
      async call(args) {
        const query = String(args.query ?? '').trim()
        if (!query) throw new Error('query 不能为空')
        const result = await deps.memory.recall({ text: query, limit: Number(args.limit ?? 5) })
        return textResult(result.text || '没有找到相关记忆。')
      },
    },
    {
      name: 'memory_remember',
      description: '把一条值得长期记住的事实写入青梅的记忆。',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          predicate: { type: 'string' },
          object: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['subject', 'predicate', 'object'],
      },
      async call(args) {
        const record: MemoryRecord = {
          kind: 'fact',
          subject: String(args.subject ?? '').trim(),
          predicate: String(args.predicate ?? '').trim(),
          object: String(args.object ?? '').trim(),
          confidence: Number(args.confidence ?? 0.8),
          sensitivity: 'private',
          origin: { kind: 'harness', id: 'mcp' },
        }
        if (!record.subject || !record.predicate || !record.object) {
          throw new Error('subject/predicate/object 都不能为空')
        }
        const result = await deps.memory.ingest([record])
        return textResult(result.created.length > 0 ? '已记住' : '已更新')
      },
    },
    {
      name: 'schedule_create',
      description:
        '创建提醒。cron 表示按周期重复（五段式“分 时 日 月 周”，可配 timezone），用于“每天九点”这类请求；' +
        'at 表示绝对时间一次性触发；只给 seconds 表示多少秒后提醒一次。优先级 cron > at > seconds。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '提醒内容' },
          cron: { type: 'string', description: '五段式 cron：分 时 日 月 周，如 0 9 * * 1-5' },
          timezone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai；缺省用服务器配置的默认时区' },
          missedPolicy: {
            type: 'string',
            enum: ['fire-once', 'skip'],
            description: '停机期间错过多次时补发一次（默认）还是跳过',
          },
          at: { type: 'string', description: '绝对时间（ISO 8601），一次性' },
          seconds: { type: 'number', description: '多少秒后提醒，默认 60' },
        },
        required: ['text'],
      },
      async call(args) {
        const text = String(args.text ?? '').trim()
        if (!text) throw new Error('text 不能为空')
        const item = await deps.schedule.create(scheduleInputFrom(text, args))
        return textResult(`已设定：${describeWhen(item)} 提醒「${text}」`)
      },
    },
    {
      name: 'schedule_cancel',
      description: '按 id 取消一条提醒（永久删除）。只想暂时别响用 schedule_pause。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      async call(args) {
        const ok = await deps.schedule.cancel(String(args.id ?? ''))
        return textResult(ok ? '已取消' : '没有找到这条提醒')
      },
    },
    {
      name: 'schedule_update',
      description:
        '按 id 修改提醒的内容或规则（cron / at / seconds 三选一）。只给 text 就只改文案；给了规则会从现在重排下一次。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '日程 id' },
          text: { type: 'string', description: '新的提醒内容' },
          cron: { type: 'string', description: '新的五段式 cron' },
          timezone: { type: 'string', description: '新的 IANA 时区' },
          at: { type: 'string', description: '新的绝对时间（ISO 8601），一次性' },
          seconds: { type: 'number', description: '改成「多少秒后」的一次性提醒' },
          missedPolicy: {
            type: 'string',
            enum: ['fire-once', 'skip'],
            description: '停机期间错过多次时补发一次还是跳过',
          },
        },
        required: ['id'],
      },
      async call(args) {
        const id = String(args.id ?? '').trim()
        if (!id) throw new Error('id 不能为空')
        const item = await deps.schedule.update(id, schedulePatchFrom(args))
        if (!item) throw new Error('这条提醒不存在或已经结束')
        return textResult(`已修改：${describeWhen(item)} 提醒「${item.text}」`)
      },
    },
    {
      name: 'schedule_pause',
      description: '按 id 暂停一条提醒：保留规则，但到点不再触发。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      async call(args) {
        const ok = await deps.schedule.pause(String(args.id ?? ''))
        return textResult(ok ? '已暂停' : '没有找到这条提醒')
      },
    },
    {
      name: 'schedule_resume',
      description: '按 id 继续一条被暂停的提醒。周期提醒会从「现在」重新排下一次。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      async call(args) {
        const ok = await deps.schedule.resume(String(args.id ?? ''))
        return textResult(ok ? '已继续' : '这条提醒不存在或已经结束')
      },
    },
    {
      name: 'qm_dispatch_task',
      description:
        '把一件事派给 harness（DSH）去执行，立刻返回 runId。适合「跑测试」「整理文件」这类需要动手的活；' +
        '进度会记在任务账本里，用 qm_report_progress / qm_finish_task 由执行方回报。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '要执行的任务，写给子 agent 看' },
          title: { type: 'string', description: '短标题，缺省取 prompt 前 40 字' },
          project: { type: 'string', description: '归属项目；项目审问按它过滤' },
          cwd: { type: 'string', description: '工作目录；缺省用青梅分配的任务目录' },
        },
        required: ['prompt'],
      },
      async call(args) {
        const prompt = String(args.prompt ?? '').trim()
        if (!prompt) throw new Error('prompt 不能为空')
        const run = await deps.task.create({
          prompt,
          ...(typeof args.title === 'string' && args.title.trim() ? { title: args.title.trim() } : {}),
          ...(typeof args.project === 'string' && args.project.trim() ? { project: args.project.trim() } : {}),
          ...(typeof args.cwd === 'string' && args.cwd.trim() ? { cwd: args.cwd.trim() } : {}),
        })
        deps.runner.dispatch(run)
        return textResult(`已派出：${run.id}「${run.title}」，进度会记在任务账本里`)
      },
    },
    {
      name: 'qm_project_status',
      description:
        '看某个项目的状态：只列该项目归属的 run，汇总进度、产物、阻塞与失败，并标注数据截止时间。' +
        '主人问「项目 X 什么情况」时必须传 project，只报该项目内的任务，不要拿别的项目凑数；' +
        '账本里没有就直说没有，可以问要不要派人盘点。数据太旧也要说明。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '项目名；省略则看最近全部任务' },
        },
      },
      async call(args) {
        const project = typeof args.project === 'string' ? args.project.trim() : ''
        const runs = await deps.task.list(50)
        const matched = project
          ? runs.filter((run) => matchesProject(run, project))
          : runs.slice(0, 5)

        if (project && matched.length === 0) {
          const recent = runs.slice(0, 3).map((run) => `- ${run.id} ${statusText(run.status)} ${run.title}`)
          return textResult(
            `账本里没有「${project}」的记录。最近的任务：\n${recent.join('\n') || '（账本还是空的）'}\n` +
              '要不要我派人去盘点一下？',
          )
        }

        const cutoff = matched.reduce((latest, run) => {
          const at = run.finishedAt ?? run.startedAt ?? run.createdAt
          return at.getTime() > latest ? at.getTime() : latest
        }, 0)
        const lines = [
          `【项目：${project || '最近任务'}】数据截止 ${formatWhen(new Date(cutoff))}`,
          ...matched.slice(0, 5).map((run) => `- ${run.id} ${statusText(run.status)} ${run.title}${runDetail(run)}`),
        ]

        const blocked = matched.filter((run) => run.status === 'needs_approval')
        if (blocked.length > 0) lines.push(`阻塞：${blocked.length} 个任务在等人确认（${blocked.map((run) => run.id).join('、')}）`)
        const failed = matched.filter((run) => run.status === 'failed')
        if (failed.length > 0) lines.push(`失败：${failed.length} 个（最近：${failed[0]!.title}）`)

        if (Date.now() - cutoff > 2 * 3600_000) {
          // 过期就用一次只读盘点换新鲜度；harness 不可用时只能降级成账本快照
          const staleNote = `注：数据已经超过 2 小时（截止 ${formatWhen(new Date(cutoff))}），可能不是最新。`
          const available = deps.harness ? await deps.harness.available().catch(() => false) : false
          if (!available) {
            lines.push(`${staleNote}harness 当前不可用，只能给你这份快照；要我稍后再试吗？`)
            return textResult(lines.join('\n'))
          }
          const latest = matched[0]!
          try {
            const run = await deps.task.create({
              prompt: inventoryPrompt(project),
              title: `盘点：${project}`,
              project,
              kind: 'inventory',
              cwd: latest.cwd,
            })
            deps.runner.dispatch(run)
            lines.push(`${staleNote}已派 ${run.id} 去做只读盘点（沿用上一次的工作目录），结论出来我会发给你。`)
          } catch (error) {
            lines.push(`${staleNote}派人盘点失败：${messageOf(error)}`)
          }
          return textResult(lines.join('\n'))
        }
        return textResult(lines.join('\n'))
      },
    },
    {
      name: 'qm_publish_artifact',
      description: '交付产物：把一个文件路径、链接或摘要登记到任务账本，主人能在任务面板里看到。',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          name: { type: 'string', description: '产物名，如「测试报告」' },
          url: { type: 'string', description: '链接' },
          path: { type: 'string', description: '文件路径（相对 run 目录或绝对路径）' },
          summary: { type: 'string', description: '一句话说明' },
        },
        required: ['runId', 'name'],
      },
      async call(args) {
        const runId = String(args.runId ?? '').trim()
        const name = String(args.name ?? '').trim()
        if (!runId) throw new Error('runId 不能为空')
        if (!name) throw new Error('name 不能为空')
        const run = await deps.task.addArtifact(runId, {
          name,
          ...(typeof args.url === 'string' ? { url: args.url } : {}),
          ...(typeof args.path === 'string' ? { path: args.path } : {}),
          ...(typeof args.summary === 'string' ? { summary: args.summary } : {}),
        })
        if (!run) throw new Error('没有这个任务，或它已经结束')
        return textResult(`已登记产物：${name}（共 ${run.artifacts.length} 个）`)
      },
    },
    {
      name: 'qm_report_progress',
      description:
        '向青梅上报当前任务进度。phase 必填；percent 可选（模型给的百分比通常不准）；note 用一句话说明卡在哪。',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '任务 id，如 run_xxx' },
          phase: { type: 'string', description: '当前阶段，如「跑测试」' },
          percent: { type: 'number', description: '0-100，可选' },
          note: { type: 'string', description: '一句话进展/卡点' },
        },
        required: ['runId', 'phase'],
      },
      async call(args) {
        const runId = String(args.runId ?? '').trim()
        const phase = String(args.phase ?? '').trim()
        if (!runId) throw new Error('runId 不能为空')
        if (!phase) throw new Error('phase 不能为空')
        const run = await deps.task.reportProgress(runId, {
          phase,
          ...(typeof args.percent === 'number' ? { percent: args.percent } : {}),
          ...(typeof args.note === 'string' ? { note: args.note } : {}),
        })
        if (!run) throw new Error('没有这个任务，或它已经结束')
        return textResult(`已记录进度：${run.progress?.phase ?? phase}`)
      },
    },
    {
      name: 'qm_finish_task',
      description: '任务收尾：写入结论与状态；可以顺带把值得记住的事实写进青梅记忆。',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          status: { type: 'string', enum: ['done', 'failed'], description: '默认 done' },
          summary: { type: 'string', description: '结论/未完成项' },
          memory: {
            type: 'array',
            description: '结构化记忆，可选',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string' },
                predicate: { type: 'string' },
                object: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['subject', 'predicate', 'object'],
            },
          },
        },
        required: ['runId'],
      },
      async call(args) {
        const runId = String(args.runId ?? '').trim()
        if (!runId) throw new Error('runId 不能为空')
        const status = args.status === 'failed' ? 'failed' : 'done'
        const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : undefined

        const records = memoryRecordsOf(args.memory, runId)
        if (records.length > 0) await deps.memory.ingest(records)

        const run = await deps.task.finish(runId, {
          status,
          ...(summary && status === 'done' ? { result: summary } : {}),
          ...(summary && status === 'failed' ? { error: summary } : {}),
        })
        if (!run) throw new Error('没有这个任务')
        return textResult(`已收尾：${status}${records.length > 0 ? `，写入 ${records.length} 条记忆` : ''}`)
      },
    },
    {
      name: 'schedule_list',
      description: '列出所有未触发的提醒（含已暂停的，暂停状态会标出来）。',
      inputSchema: { type: 'object', properties: {} },
      async call() {
        const items = await deps.schedule.list()
        const active = items.filter((item) => item.firedAt === null)
        // 带上 id：没有 id，模型就无法用 schedule_cancel 取消已有日程
        const text = active.length
          ? active.map((item) => `- [${item.id}] ${describeWhen(item)} ${item.text}`).join('\n')
          : '没有待触发的提醒。'
        return textResult(text)
      },
    },
  ]
}

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  needs_approval: '等确认',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

function statusText(status: string): string {
  return STATUS_TEXT[status] ?? status
}

function matchesProject(run: TaskRun, project: string): boolean {
  const needle = project.toLowerCase()
  return [run.project ?? '', run.title, run.prompt].some((value) => value.toLowerCase().includes(needle))
}

function runDetail(run: TaskRun): string {
  const parts: string[] = []
  if (run.progress?.phase) parts.push(`进度：${run.progress.phase}`)
  if (run.artifacts.length > 0) parts.push(`产物 ${run.artifacts.length}`)
  const outcome = run.result ?? run.error
  if (outcome) parts.push(outcome.slice(0, 60))
  return parts.length > 0 ? ` ｜ ${parts.join(' ｜ ')}` : ''
}

function inventoryPrompt(project: string): string {
  return (
    `只读盘点（不要修改任何文件、不要安装依赖）：项目「${project}」的当前状态。` +
    '查看当前目录的文件与最近变更（有 git 就用 git status/log），用不超过三行回答：现状、阻塞、建议下一步。' +
    '最后必须调用 qm_finish_task：status 用 done，summary 写这三行结论。'
  )
}

function formatWhen(at: Date): string {
  return at.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: false }
}

/** 把 qm_finish_task 的 memory 参数折成可写入的记忆记录 */
function memoryRecordsOf(raw: unknown, runId: string): MemoryRecord[] {
  if (!Array.isArray(raw)) return []
  const records: MemoryRecord[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const subject = String(entry.subject ?? '').trim()
    const predicate = String(entry.predicate ?? '').trim()
    const object = String(entry.object ?? '').trim()
    if (!subject || !predicate || !object) continue
    records.push({
      kind: 'fact',
      subject,
      predicate,
      object,
      confidence: typeof entry.confidence === 'number' ? entry.confidence : 0.7,
      sensitivity: 'private',
      origin: { kind: 'harness', id: `task:${runId}` },
    })
  }
  return records
}

export class McpHost extends McpService {
  private readonly server: Server
  private readonly options: Required<McpConfig>
  private readonly tools: HostTool[]
  private readonly toolsByName: Map<string, HostTool>
  private readonly guard: ToolGuard

  constructor(ctx: Context, config: McpConfig = {}) {
    super(ctx)
    const memory = ctx.reflect.get('memory', false) as MemoryService | undefined
    if (!memory) throw new Error('[host-mcp] 缺少 memory 服务')
    const schedule = ctx.reflect.get('schedule', false) as ScheduleService | undefined
    if (!schedule) throw new Error('[host-mcp] 缺少 schedule 服务')
    const task = ctx.reflect.get('task', false) as TaskService | undefined
    if (!task) throw new Error('[host-mcp] 缺少 task 服务')
    const runner = ctx.reflect.get('taskRunner', false) as TaskRunnerService | undefined
    if (!runner) throw new Error('[host-mcp] 缺少 taskRunner 服务')
    const permission = ctx.reflect.get('permission', false) as PermissionService | undefined
    if (!permission) throw new Error('[host-mcp] 缺少 permission 服务')
    const audit = ctx.reflect.get('audit', false) as AuditService | undefined
    if (!audit) throw new Error('[host-mcp] 缺少 audit 服务')
    const approval = ctx.reflect.get('approval', false) as ApprovalService | undefined
    if (!approval) throw new Error('[host-mcp] 缺少 approval 服务')

    const harness = ctx.reflect.get('harness', false) as HarnessService | undefined
    this.tools = createTools({ memory, schedule, task, runner, ...(harness ? { harness } : {}) })
    this.toolsByName = new Map(this.tools.map((tool) => [tool.name, tool]))
    this.guard = {
      permission,
      audit,
      approval,
      actor: { id: config.actorId?.trim() || 'owner', displayName: '主人', role: 'owner' },
      channel: 'web',
      conversation: config.conversation === 'group' ? 'group' : 'dm',
      approvalTimeoutMs: config.approvalTimeoutMs,
    }
    this.options = {
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 7420,
      token: config.token ?? '',
      path: config.path ?? '/mcp',
    }
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
    this.server.listen(this.options.port, this.options.host)
    ctx.effect(() => () => {
      this.server.close()
    })
  }

  servers(): unknown[] {
    const headers = this.options.token
      ? [{ name: 'Authorization', value: `Bearer ${this.options.token}` }]
      : undefined
    return [
      {
        type: 'http',
        name: 'qingmei',
        url: `http://${this.options.host}:${this.options.port}${this.options.path}`,
        ...(headers ? { headers } : {}),
      },
    ]
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== this.options.path) {
      res.writeHead(404).end()
      return
    }
    if (this.options.token) {
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${this.options.token}`) {
        sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' } })
        return
      }
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }

    const body = await readJson(req)
    if (body === null) {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } })
      return
    }
    const message = body as { id?: number | string; method?: string; params?: Record<string, unknown> }
    if (message.method === 'notifications/initialized' || message.id === undefined) {
      res.writeHead(202).end()
      return
    }

    try {
      const result = await this.dispatch(message.method ?? '', message.params ?? {})
      sendJson(res, 200, { jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: messageOf(error) },
      })
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'initialize') {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'qingmei-memory', version: '0.1.0' },
      }
    }
    if (method === 'ping') return {}
    if (method === 'tools/list') {
      return {
        tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      }
    }
    if (method === 'tools/call') {
      const name = String(params.name ?? '')
      const tool = this.toolsByName.get(name)
      if (!tool) throw new Error(`未知工具：${name}`)
      const args = (params.arguments ?? {}) as Record<string, unknown>
      // 先过权限与审计，再执行。被拒绝的调用也会留痕
      await guardToolCall(this.guard, name)
      return await tool.call(args)
    }
    throw new Error(`未知方法：${method}`)
  }
}

/**
 * 把工具参数折成 ScheduleInput。
 *
 * cron 优先，其次 ISO 时间，最后才是 seconds 倒计时。秒级请求一律换算成绝对时间，
 * 走一次性路径——否则“60 秒后提醒我”会变成每 60 秒重复一次。
 */
export function scheduleInputFrom(text: string, args: Record<string, unknown>): ScheduleInput {
  const cron = typeof args.cron === 'string' ? args.cron.trim() : ''
  const timezone = typeof args.timezone === 'string' ? args.timezone.trim() : ''
  const missedPolicy =
    args.missedPolicy === 'skip' ? 'skip' : args.missedPolicy === 'fire-once' ? 'fire-once' : undefined
  if (cron) {
    return {
      text,
      cron,
      ...(timezone ? { timezone } : {}),
      ...(missedPolicy ? { missedPolicy } : {}),
    }
  }

  const atRaw = typeof args.at === 'string' ? Date.parse(args.at) : Number.NaN
  if (Number.isFinite(atRaw)) return { text, at: new Date(atRaw) }

  const seconds = Number(args.seconds ?? 60)
  const delayMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000
  return { text, at: new Date(Date.now() + delayMs) }
}

/**
 * 把工具参数折成 SchedulePatch（只带显式给出的字段）。
 *
 * 一个字段都没有就报错：静默什么都不改比报错更难查。
 */
export function schedulePatchFrom(args: Record<string, unknown>): SchedulePatch {
  const patch: SchedulePatch = {}
  if (typeof args.text === 'string') patch.text = args.text
  if (typeof args.cron === 'string' && args.cron.trim()) patch.cron = args.cron.trim()
  if (typeof args.timezone === 'string' && args.timezone.trim()) patch.timezone = args.timezone.trim()
  const atRaw = typeof args.at === 'string' ? Date.parse(args.at) : Number.NaN
  if (Number.isFinite(atRaw)) patch.at = new Date(atRaw)
  const seconds = Number(args.seconds)
  if (Number.isFinite(seconds) && seconds > 0) patch.everyMs = seconds * 1000
  if (args.missedPolicy === 'skip' || args.missedPolicy === 'fire-once') {
    patch.missedPolicy = args.missedPolicy
  }
  if (Object.keys(patch).length === 0) throw new Error('没有可修改的字段')
  return patch
}

function describeWhen(item: Scheduled): string {
  const paused = item.pausedAt ? '（已暂停）' : ''
  if (item.cron) {
    return `${paused}每次 ${item.cron}（${item.timezone ?? '默认时区'}），下次 ${item.nextAt.toISOString()}`
  }
  return `${paused}${item.nextAt.toISOString()}`
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
      if (raw.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: Context, config: McpConfig = {}): void {
  ctx.plugin(McpHost, config)
}

export const defaultExport = { name, inject, apply }
