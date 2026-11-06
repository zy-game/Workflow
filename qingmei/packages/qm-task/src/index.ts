/**
 * @qingmei/qm-task —— 把任务派给 harness 并记账。
 *
 * 职责边界（docs/07）：青梅决定「做什么、什么时候」；harness 决定「怎么做」。
 * 本插件做三件事：
 *   - 提供 `taskRunner` 服务：把某个 run 交给 harness（worker/ACP 负责执行与回传）
 *   - `POST /api/v1/tasks` 建 run 并派发；`GET /api/v1/tasks[?id=]` 查询
 *   - 把任务状态变化推给 SSE（task-started / task-progress / task-finished）
 *
 * 执行结果由 worker/ACP 回传；子 agent 不依赖 MCP 工具。
 * 子 agent 没汇报也不会卡住：会话正常结束就把累计文本当结论收尾。
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import {
  EVENTS,
  TaskRunnerService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type HarnessService,
  type TaskContract,
  type TaskRun,
  type TaskService,
} from '@qingmei/core'

export interface TaskConfig {
  /** run 目录的根；不配则沿用 provider-task-sqlite 的默认值 */
  workspaceRoot?: string
  /** 单次执行的时间上限，默认 10 分钟 */
  timeoutMs?: number
  /** 派给哪个 harness */
  harnessId?: string
  /** 同时最多跑几个 run；超出的排队，默认 2 */
  maxConcurrent?: number
  /** 静默时段（如 23:00-08:00）：非紧急任务不启动，跨午夜也支持 */
  quietHours?: { start: string; end: string }
  /** 达到该优先级才允许抢占低优（默认 9；0 关闭） */
  preemptPriority?: number
  /** 静默时段仍允许启动的优先级下限，默认 8 */
  urgentPriority?: number
}

export const name = 'qm-task'
export const inject = ['task', 'gateway']

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_HARNESS = 'dsh'
const DEFAULT_MAX_CONCURRENT = 2
const LIST_LIMIT = 20

interface RunnerDeps {
  task: TaskService
  timeoutMs: number
  maxConcurrent: number
  quietHours: QuietRange | null
  urgentPriority: number
  preemptPriority: number
}

export class TaskRunner extends TaskRunnerService {
  private readonly ctx: Context
  private readonly deps: RunnerDeps
  private readonly queue: TaskRun[] = []
  private readonly activeRuns = new Map<string, TaskRun>()
  private readonly controllers = new Map<string, AbortController>()
  private pumping = false
  private pumpQueued = false
  private quietTimer: ReturnType<typeof setTimeout> | null = null

  constructor(ctx: Context, deps: RunnerDeps) {
    super(ctx)
    this.ctx = ctx
    this.deps = deps
  }

  /** harness 是可选依赖，且比本插件晚加载——每次派发时再取，不能在建插件时捕获 */
  private harness(): HarnessService | undefined {
    return this.ctx.reflect.get('harness', false) as HarnessService | undefined
  }

  dispatch(run: TaskRun): void {
    this.queue.push(run)
    void this.pump()
  }

  /** 当前占用与排队长度（诊断用） */
  stats(): { active: number; queued: number; quiet: boolean } {
    return {
      active: this.activeRuns.size,
      queued: this.queue.length,
      quiet: this.deps.quietHours !== null && inQuietHours(new Date(), this.deps.quietHours),
    }
  }

  /**
   * 并发容量 + 优先级 + 静默时间窗 + DAG 依赖（docs/13 的「现在做哪个、什么时候做」）。
   * 先按 priority 降序、再按到达顺序；依赖未完成的任务留在队列里等，不占并发。
   */
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpQueued = true
      return
    }
    this.pumping = true
    try {
      for (;;) {
        if (this.activeRuns.size < this.deps.maxConcurrent) {
          const run = await this.pick()
          if (!run) break
          this.activeRuns.set(run.id, run)
          void this.execute(run).finally(() => {
            this.activeRuns.delete(run.id)
            void this.pump()
          })
          continue
        }
        if (this.deps.preemptPriority <= 0) break
        if (!(await this.preempt())) break
      }
    } finally {
      this.pumping = false
      if (this.pumpQueued) {
        this.pumpQueued = false
        void this.pump()   
      }
    }
  }

  /** 取消排队或执行中的 run：排队中直接出队；执行中 abort 并记 cancelled */
  async cancel(id: string, reason = '被主人取消'): Promise<boolean> {
    const queued = this.queue.findIndex((run) => run.id === id)
    if (queued >= 0) {
      this.queue.splice(queued, 1)
      await this.deps.task.finish(id, { status: 'cancelled', error: reason })
      return true
    }
    const controller = this.controllers.get(id)
    if (!controller) return false
    controller.abort()
    await this.deps.task.finish(id, { status: 'cancelled', error: reason })
    return true
  }

  /**
   * 抢占：队列头是紧急任务、且没有空闲容量时，取消一个已落 checkpoint 的低优 run。
   * checkpoint 的判据是「有进度或已有 harness 会话」——没有的话按 docs/13 不允许抢占。
   */
  private async preempt(): Promise<boolean> {
    const head = this.queue[0]
    if (!head || (head.priority ?? 5) < this.deps.preemptPriority) return false

    const active = await Promise.all(
      [...this.activeRuns.keys()].map(async (id) => (await this.deps.task.get(id)) ?? this.activeRuns.get(id)!),
    )
    const victims = active
      .filter((run) => (run.priority ?? 5) < (head.priority ?? 5))
      .filter((run) => run.progress !== null || run.sessionId !== null)
      .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5))
    const victim = victims[0]
    if (!victim) return false

    await this.cancel(victim.id, `被更高优先级任务 ${head.id} 抢占（checkpoint 已保留）`)
    // 等执行槽真正释放，避免同一轮反复抢同一个 run
    for (let i = 0; i < 50 && this.activeRuns.has(victim.id); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return true
  }
  /** 取出下一个该跑的；依赖未就绪/静默时段没有紧急任务就等或安排窗后重试 */
  private async pick(): Promise<TaskRun | null> {
    if (this.queue.length === 0) return null
    this.queue.sort(
      (a, b) => (b.priority ?? 5) - (a.priority ?? 5) || a.createdAt.getTime() - b.createdAt.getTime(),
    )

    const quiet = this.deps.quietHours !== null && inQuietHours(new Date(), this.deps.quietHours)
    const candidates = quiet
      ? this.queue.filter((run) => (run.priority ?? 5) >= this.deps.urgentPriority)
      : [...this.queue]

    for (const candidate of candidates) {
      const state = await this.dependencyState(candidate)
      if (state === 'failed') return this.pick()
      if (state === 'blocked') continue
      this.remove(candidate.id)
      return candidate
    }

    if (quiet) this.scheduleAfterQuiet()
    return null
  }

  /**
   * 依赖状态：ready 可跑；blocked 等前置；failed 已把本任务标失败（不存在/失败/成环）。
   */
  private async dependencyState(run: TaskRun): Promise<'ready' | 'blocked' | 'failed'> {
    if (run.dependsOn.length === 0) return 'ready'
    if (await this.hasCycle(run)) {
      this.remove(run.id)
      await this.deps.task.finish(run.id, { status: 'failed', error: '依赖成环' })
      return 'failed'
    }

    for (const dependencyId of run.dependsOn) {
      const dependency = await this.deps.task.get(dependencyId)
      if (!dependency) {
        this.remove(run.id)
        await this.deps.task.finish(run.id, { status: 'failed', error: `前置任务 ${dependencyId} 不存在` })
        return 'failed'
      }
      if (dependency.status === 'failed' || dependency.status === 'cancelled') {
        this.remove(run.id)
        await this.deps.task.finish(run.id, {
          status: 'failed',
          error: `前置任务 ${dependencyId} ${dependency.status === 'cancelled' ? '被取消' : '失败'}`,
        })
        return 'failed'
      }
      if (dependency.status !== 'done') return 'blocked'
    }
    return 'ready'
  }

  /** 从依赖图里找回到 run 的环；缺的依赖交给 dependencyState 报错 */
  private async hasCycle(run: TaskRun): Promise<boolean> {
    const seen = new Set<string>()
    const stack = [...run.dependsOn]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (id === run.id) return true
      if (seen.has(id)) continue
      seen.add(id)
      const node = await this.deps.task.get(id)
      if (node) stack.push(...node.dependsOn)
    }
    return false
  }

  private remove(id: string): void {
    const index = this.queue.findIndex((run) => run.id === id)
    if (index >= 0) this.queue.splice(index, 1)
  }

  /** 静默时段结束时再泵一次，否则队列会一直停到下一个事件 */
  /** 插件卸载时清掉窗口定时器 */
  stop(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = null
  }

  private scheduleAfterQuiet(): void {
    const range = this.deps.quietHours
    if (!range || this.quietTimer) return
    const delay = Math.max(1_000, msUntilQuietEnd(new Date(), range))
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null
      void this.pump()
    }, delay)
    this.quietTimer.unref?.()
  }

  private async execute(run: TaskRun): Promise<void> {
    const { task, timeoutMs } = this.deps
    const harness = this.harness()
    if (!harness) {
      await task.finish(run.id, { status: 'failed', error: '没有可用的 harness' })
      return
    }
    const conversationId = `task_${run.id}`
    const controller = new AbortController()
    this.controllers.set(run.id, controller)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let collected = ''
    let failure: string | null = null
    const tokenBudget = run.contract?.tokenBudget
    let spentTokens = run.usage?.totalTokens ?? 0
    let budgetExceeded = false
    if (tokenBudget && spentTokens >= tokenBudget) {
      await task.finish(run.id, {
        status: 'failed',
        error: `token 预算已用尽：${spentTokens}/${tokenBudget}`,
      })
      this.controllers.delete(run.id)
      clearTimeout(timer)
      return
    }

    try {
      const cwd = path.resolve(run.cwd)
      await mkdir(cwd, { recursive: true })
      await task.start(run.id)

      for await (const event of harness.run({
        conversationId,
        text: taskPrompt(run, cwd),
        cwd,
        ...(run.sessionId ? { resumeSessionId: run.sessionId } : {}),
        signal: controller.signal,
        // 会话建好后把 harness 侧 id 记进账本（以后 resume 用）
        onSession: (sessionId) => {
          void task.start(run.id, { sessionId }).catch(() => undefined)
        },
      })) {
        if (event.type === 'text') collected += event.text
        else if (event.type === 'error') failure = event.message
        else if (event.type === 'usage') {
          await task.reportUsage(run.id, event.usage).catch(() => undefined)
          spentTokens += Number(event.usage.totalTokens) || 0
          if (tokenBudget && spentTokens > tokenBudget) {
            budgetExceeded = true
            failure = `token 预算超限：${spentTokens}/${tokenBudget}`
            controller.abort()
            break
          }
        }
      }
    } catch (error) {
      failure = messageOf(error)
    } finally {
      this.controllers.delete(run.id)
      clearTimeout(timer)
      const current = await task.get(run.id)
      // 子 agent 可能已经由 worker 收尾；那样就不再覆盖
      if (current && current.finishedAt === null) {
        if (budgetExceeded) {
          await task.finish(run.id, { status: 'failed', error: failure ?? 'token 预算超限' })
        } else if (controller.signal.aborted) {
          await task.finish(run.id, { status: 'cancelled', error: `超过 ${timeoutMs}ms 未完成` })
        } else if (failure) {
          await task.finish(run.id, { status: 'failed', error: failure })
        } else {
          const result = collected.trim()
          await task.finish(run.id, { status: 'done', ...(result ? { result } : {}) })
        }
      }
      await harness.close(conversationId).catch(() => undefined)
    }
  }
}

function normalizeContract(raw: unknown): TaskContract | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const body = raw as Record<string, unknown>
  const levels: TaskContract['enforcement'][] = ['nudge', 'firm', 'strict', 'contract']
  const signals: TaskContract['progressSignal'][] = ['harness-run', 'self-report', 'artifact', 'milestone']
  const enforcement = levels.includes(body.enforcement as TaskContract['enforcement'])
    ? (body.enforcement as TaskContract['enforcement'])
    : 'firm'
  const deadline = typeof body.deadline === 'string' ? new Date(body.deadline) : undefined
  const tokenBudget = Number(body.tokenBudget)
  const normalizedBudget = Number.isFinite(tokenBudget) && tokenBudget > 0 ? Math.round(tokenBudget) : undefined
  const expected = Array.isArray(body.expected)
    ? body.expected
        .map((item) => {
          const entry = item as { at?: unknown; percent?: unknown }
          const at = typeof entry.at === 'string' ? new Date(entry.at) : null
          if (!at || Number.isNaN(at.getTime())) return null
          return { at, percent: Math.min(100, Math.max(0, Number(entry.percent) || 0)) }
        })
        .filter((item): item is { at: Date; percent: number } => item !== null)
    : undefined
  return {
    enforcement,
    ...(deadline && !Number.isNaN(deadline.getTime()) ? { deadline } : {}),
    ...(signals.includes(body.progressSignal as TaskContract['progressSignal'])
      ? { progressSignal: body.progressSignal as TaskContract['progressSignal'] }
      : {}),
    ...(expected && expected.length > 0 ? { expected } : {}),
    ...(Array.isArray(body.allowedActions) ? { allowedActions: body.allowedActions.map(String) } : {}),
    ...(body.escape && typeof body.escape === 'object'
      ? {
          escape: {
            perDay: Number((body.escape as { perDay?: number }).perDay ?? 1),
            hours: Number((body.escape as { hours?: number }).hours ?? 2),
          },
        }
      : {}),
    ...(normalizedBudget ? { tokenBudget: normalizedBudget } : {}),
  }
}
export function apply(ctx: Context, config: TaskConfig = {}): void {
  const task = ctx.reflect.get('task', false) as TaskService | undefined
  if (!task) throw new Error('[qm-task] 缺少 task 服务')
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!gateway) throw new Error('[qm-task] 缺少 gateway 服务')
  /** harness 是可选依赖：开发环境可能没装 DSH，此时派发返回「没有可用的 harness」 */
  const harness = ctx.reflect.get('harness', false) as HarnessService | undefined

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const resumeOnRestart = config.resumeOnRestart !== false
  const harnessId = config.harnessId ?? DEFAULT_HARNESS
  const maxConcurrent = Math.max(1, Number(config.maxConcurrent) || DEFAULT_MAX_CONCURRENT)
  const quietHours = parseQuietHours(config.quietHours)
  const preemptPriority = Number.isFinite(Number(config.preemptPriority))
    ? Math.min(9, Math.max(0, Math.round(Number(config.preemptPriority))))
    : DEFAULT_PREEMPT_PRIORITY
  const urgentPriority = Number.isFinite(Number(config.urgentPriority))
    ? Math.min(9, Math.max(0, Math.round(Number(config.urgentPriority))))
    : DEFAULT_URGENT_PRIORITY
  const runner = new TaskRunner(ctx, { task, timeoutMs, maxConcurrent, quietHours, urgentPriority, preemptPriority })
  ctx.effect(() => () => runner.stop())

  // 任务状态变化推给 SSE，Web 任务面板直接订阅
  for (const [event, type] of [
    [EVENTS.taskRunStarted, 'task-started'],
    [EVENTS.taskProgress, 'task-progress'],
    [EVENTS.taskFinished, 'task-finished'],
  ] as const) {
    ctx.events.on(event, (run: TaskRun) => {
      gateway.publish({ type, data: run })
    })
  }


  // 重启恢复：排队中的重新排队；执行中的没有 resume，就如实记失败
  void (async () => {
    try {
      const runs = (await task.list(50)).slice().reverse()
      const available = harness ? await harness.available().catch(() => false) : false
      for (const run of runs) {
        if (run.harnessId !== harnessId) continue
        if (run.status === 'queued') {
          if (available) runner.dispatch(run)
          continue
        }
        if (run.status === 'running' || run.status === 'needs_approval') {
          if (resumeOnRestart) {
            const resumed = await task.resume(run.id)
            if (resumed && available) runner.dispatch(resumed)
            ctx.logger.info('[qm-task] 重启恢复：' + run.id + ' 重新排队')
            continue
          }
          await task.finish(run.id, {
            status: 'failed',
            error: '进程重启：任务在执行中被中断（resume 未实现）',
          })
        }
      }
    } catch (error) {
      ctx.logger.warn(`[qm-task] 重启恢复失败：${messageOf(error)}`)
    }
  })()
  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/tasks',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (!prompt) {
          res.status(400).send({ ok: false, error: 'prompt 不能为空' })
          return
        }

        const available = harness ? await harness.available().catch(() => false) : false
        if (!harness || !available) {
          res.status(503).send({ ok: false, error: '没有可用的 harness' })
          return
        }

        const run = await task.create({
          prompt,
          ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {}),
          ...(typeof body.project === 'string' && body.project.trim() ? { project: body.project.trim() } : {}),
          ...(typeof body.cwd === 'string' && body.cwd.trim() ? { cwd: body.cwd.trim() } : {}),
          ...(Number.isFinite(Number(body.priority)) ? { priority: Number(body.priority) } : {}),
          ...(Array.isArray(body.dependsOn)
            ? { dependsOn: body.dependsOn.map((item) => String(item)).filter(Boolean) }
            : {}),
          ...(normalizeContract(body.contract) ? { contract: normalizeContract(body.contract)! } : {}),
          harnessId,
        })
        res.status(202).send({ ok: true, run })
        // 派发是后台动作：HTTP 先返回 run，进度靠事件与轮询
        runner.dispatch(run)
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/tasks',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const id = (req.query.id ?? '').trim()
        if (id) {
          const run = await task.get(id)
          if (!run) {
            res.status(404).send({ ok: false, error: '没有这个任务' })
            return
          }
          res.status(200).send({ ok: true, run })
          return
        }
        const limit = Number(req.query.limit ?? LIST_LIMIT)
        res.status(200).send({ ok: true, items: await task.list(Number.isFinite(limit) ? limit : LIST_LIMIT) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/tasks/resume',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 不能为空' })
          return
        }
        const run = await task.resume(id)
        if (!run) {
          res.status(404).send({ ok: false, error: '没有这个任务' })
          return
        }
        if (run.status !== 'done' && run.status !== 'cancelled') {
          const available = harness ? await harness.available().catch(() => false) : false
          if (available) runner.dispatch(run)
        }
        res.status(200).send({ ok: true, run })
      },
    }),
  )
}

/** 把 runId 与上报方式写进 prompt：子 agent 只有知道 id 才能汇报 */
function taskPrompt(run: TaskRun, cwd: string): string {
  return [
    '你是青梅派出的执行子 agent。',
    `本次运行的 runId 是 ${run.id}，工作目录是 ${cwd}。`,
    '直接执行任务，结束时用一句话给出结论。',
    '进度和结果由 worker/ACP 自动记录。',
    '',
    `任务：${run.prompt}`,
  ].join('\n')
}

const DEFAULT_URGENT_PRIORITY = 8
const DEFAULT_PREEMPT_PRIORITY = 9

/** 解析 "HH:MM" 为分钟；两端都合法才生效 */
export function parseQuietHours(input?: { start?: string; end?: string }): QuietRange | null {
  if (!input?.start || !input?.end) return null
  const start = clockMinutes(input.start)
  const end = clockMinutes(input.end)
  if (start === null || end === null || start === end) return null
  return { start, end }
}

export interface QuietRange {
  /** 0..1439 */
  start: number
  end: number
}

function clockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

/** 支持跨午夜（23:00-08:00） */
export function inQuietHours(now: Date, range: QuietRange): boolean {
  const minutes = minutesOfDay(now)
  return range.start < range.end
    ? minutes >= range.start && minutes < range.end
    : minutes >= range.start || minutes < range.end
}

/** 距离静默时段结束还有多久（毫秒），用于安排窗后重泵 */
export function msUntilQuietEnd(now: Date, range: QuietRange): number {
  const minutes = minutesOfDay(now)
  const target = range.end
  const diff = target > minutes ? target - minutes : 24 * 60 - minutes + target
  const secondsIntoMinute = now.getSeconds() * 1000 + now.getMilliseconds()
  return diff * 60_000 - secondsIntoMinute
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const defaultExport = { name, inject, apply }
