/**
 * @qingmei/qm-autonomy —— 自主循环骨架（docs/13 §3，A1 建议模式）。
 *
 * 每 tick 一次：世界状态快照 → 规则候选 → 过滤（静默/预算/冷却）→ 选一条 → 记 decision trace。
 * A1 只产生建议，不执行动作；每条建议都带理由，Web 的「主动」面板可回看。
 *
 * 存储与循环放在同一个插件里：`qm_*` 是业务编排，自己的集合自己管（与 qm-history 一致）。
 */
import type { Context } from 'cordis'
import {
  AUTONOMY_ACTIONS,
  AutonomyService,
  EVENTS,
  uid,
  type ApprovalService,
  type AutonomyExecution,
  type AutonomyLevel,
  type AutonomyCandidate,
  type AutonomySnapshot,
  type AutonomyState,
  type AutonomyTrace,
  type GatewayRequest,
  type GatewayResponse,
  type ChannelService,
  type GatewayService,
  type Row,
  type ScheduleService,
  type Scheduled,
  type StoreService,
  type TaskService,
  type TaskRunnerService,
  type TaskRun,
} from '@qingmei/core'

export interface AutonomyConfig {
  /** tick 间隔；0 表示只手动触发（测试用） */
  tickMs?: number
  mode?: AutonomyLevel
  /** 每日主动建议上限 */
  dailyBudget?: number
  /** 静默时段（本地小时，左闭右开，可跨零点） */
  quietStart?: number
  quietEnd?: number
  /** 同一规则的冷却分钟数 */
  cooldownMinutes?: number
  /** 日程「即将开始」的前瞻窗口 */
  upcomingWindowMinutes?: number
  /** 决策账本保留天数；0 表示不清理 */
  retentionDays?: number
}

export const name = 'qm-autonomy'
export const inject = ['store', 'approval', 'task', 'schedule', 'gateway', 'channel', 'taskRunner']

const TRACE = 'qm_autonomy_trace'
const STATE = 'qm_autonomy_state'
const LIST_LIMIT = 20

const DEFAULTS = {
  tickMs: 300_000,
  mode: 'A1' as const,
  dailyBudget: 3,
  quietStart: 23,
  quietEnd: 8,
  cooldownMinutes: 240,
  upcomingWindowMinutes: 60,
  retentionDays: 7,
}

interface TraceRow extends Row {
  at: number
  trigger: string
  mode: string
  snapshot_json: string
  candidates_json: string
  chosen_json: string | null
  execution_json: string | null
  suppressed_json: string
  budget_json: string
  reason: string
}

interface StateRow extends Row {
  mode: string
  day: string
  used: number
  last_tick_at: number | null
  cooldowns_json: string
}

class AutonomyRunner extends AutonomyService {
  private readonly config: Required<AutonomyConfig>
  private readonly traces
  private readonly states
  private readonly approval: ApprovalService
  private readonly task: TaskService
  private readonly schedule: ScheduleService
  private readonly gateway: GatewayService
  private readonly channel: ChannelService
  private readonly taskRunner: TaskRunnerService
  private lastAt = 0

  constructor(ctx: Context, config: AutonomyConfig = {}) {
    super(ctx)
    this.config = { ...DEFAULTS, ...config }
    const store = ctx.reflect.get('store', false) as StoreService | undefined
    if (!store) throw new Error('[qm-autonomy] 缺少 store 服务')
    this.approval = ctx.reflect.get('approval', false) as ApprovalService
    this.task = ctx.reflect.get('task', false) as TaskService
    this.schedule = ctx.reflect.get('schedule', false) as ScheduleService
    this.gateway = ctx.reflect.get('gateway', false) as GatewayService
    this.channel = ctx.reflect.get('channel', false) as ChannelService
    this.taskRunner = ctx.reflect.get('taskRunner', false) as TaskRunnerService
    this.traces = store.collection<TraceRow>(TRACE)
    this.states = store.collection<StateRow>(STATE)
  }

  async tick(trigger: 'tick' | 'manual'): Promise<AutonomyTrace> {
    const now = new Date()
    const state = await this.getState()
    const day = dayKey(now)
    if (state.day !== day) {
      state.day = day
      state.used = 0
    }

    const snapshot = await this.snapshot(now)
    const candidates = await this.candidates(snapshot, now)
    const suppressed: { id: string; reason: string }[] = []
    let chosen: AutonomyCandidate | null = null
    let reason = ''

    const quiet = isQuiet(now, this.config.quietStart, this.config.quietEnd)
    if (quiet) {
      for (const candidate of candidates) suppressed.push({ id: candidate.id, reason: '静默时段' })
      reason = `静默时段（${this.config.quietStart}:00–${this.config.quietEnd}:00），只记录不说话`
    } else if (this.config.mode === 'A0') {
      for (const candidate of candidates) suppressed.push({ id: candidate.id, reason: 'A0 观察模式' })
      reason = 'A0 观察模式：只记录，不动作'
    } else if (state.used >= this.config.dailyBudget) {
      for (const candidate of candidates) suppressed.push({ id: candidate.id, reason: '今日预算用完' })
      reason = `今日建议已用 ${state.used}/${this.config.dailyBudget}，不再打扰`
    } else {
      const allowed: AutonomyCandidate[] = []
      for (const candidate of candidates) {
        const until = state.cooldowns[candidate.id] ?? 0
        if (until > now.getTime()) {
          suppressed.push({ id: candidate.id, reason: `冷却中（至 ${new Date(until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）` })
          continue
        }
        allowed.push(candidate)
      }
      if (allowed.length === 0) {
        reason = candidates.length === 0 ? '没有值得打扰的事' : '候选都在冷却中'
      } else {
        chosen = allowed.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))[0]!
        state.used += 1
        state.cooldowns[chosen.id] = now.getTime() + this.config.cooldownMinutes * 60_000
        reason = chosen.reason
      }
    }

    // 清理过期冷却，避免状态无限膨胀
    for (const [id, until] of Object.entries(state.cooldowns)) {
      if (until <= now.getTime()) delete state.cooldowns[id]
    }
    state.mode = this.config.mode
    state.lastTickAt = now
    await this.saveState(state)

    // 选中后要真的处理：能执行就执行，级别不够就降级成建议——但都要留回执
    const execution = chosen ? await this.execute(chosen, now) : null

    const trace: AutonomyTrace = {
      id: uid('aut'),
      at: now,
      trigger,
      mode: this.config.mode,
      snapshot,
      candidates,
      chosen,
      suppressed,
      budget: { day, limit: this.config.dailyBudget, used: state.used },
      execution,
      reason,
    }
    await this.appendTrace(trace)
    await this.prune(now)
    this.ctx.events.emit(EVENTS.autonomyTick, trace)
    this.gateway.publish({ type: 'autonomy-tick', data: trace })
    return trace
  }

  /**
   * 执行（或降级）选中项。
   *
   * 两级闸（docs/13 §4）：级别不够不执行；不可逆动作永远人工。
   * 执行结果写成回执——没有回执的主动行为等同于「声称做了但没做」。
   */
  private async execute(chosen: AutonomyCandidate, at: Date): Promise<AutonomyExecution> {
    const spec = AUTONOMY_ACTIONS[chosen.action]
    if (!spec) {
      return { status: 'skipped', action: chosen.action, detail: '不在行动白名单，拒绝执行', at }
    }
    if (!spec.reversible) {
      return { status: 'skipped', action: chosen.action, detail: '不可逆动作必须人工确认，自主循环不执行', at }
    }

    if (levelOf(this.config.mode) < levelOf(spec.minLevel)) {
      if (this.config.mode === 'A0') {
        return { status: 'skipped', action: chosen.action, detail: `需要 ${spec.minLevel}，A0 只记录`, at }
      }
      // 级别不够：至少把「建议」发出去，让人有机会点头
      const sent = await this.notify(`💡 ${chosen.title}\n${chosen.reason}`)
      return sent.ok
        ? { status: 'suggested', action: 'notify.self', detail: `需要 ${spec.minLevel}，当前 ${this.config.mode}：已按建议发出`, at }
        : { status: 'failed', action: 'notify.self', detail: `建议发送失败：${sent.error ?? '未知原因'}`, at }
    }

    if (chosen.action === 'notify.self') {
      const sent = await this.notify(`💡 ${chosen.title}\n${chosen.reason}`)
      return sent.ok
        ? { status: 'executed', action: 'notify.self', detail: '已发到主人私聊', at }
        : { status: 'failed', action: 'notify.self', detail: `发送失败：${sent.error ?? '未知原因'}`, at }
    }

    if (chosen.action === 'task.retry') {
      const runId = typeof chosen.payload?.runId === 'string' ? chosen.payload.runId : ''
      const original = runId ? await this.task.get(runId) : null
      if (!original) {
        return { status: 'failed', action: 'task.retry', detail: '找不到要重试的原任务', at }
      }
      try {
        const run = await this.task.create({
          prompt: original.prompt,
          title: `重试：${original.title}`,
        })
        this.taskRunner.dispatch(run)
        return { status: 'executed', action: 'task.retry', detail: `已重新派发 ${run.id}`, runId: run.id, at }
      } catch (error) {
        return { status: 'failed', action: 'task.retry', detail: `派发失败：${messageOf(error)}`, at }
      }
    }

    return { status: 'skipped', action: chosen.action, detail: '这个动作还没有执行器', at }
  }

  private async notify(text: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await this.channel.send({
        channel: 'web',
        conversationId: 'owner',
        blocks: [{ type: 'text', text }],
      })
      return result.ok ? { ok: true } : { ok: false, ...(result.error ? { error: result.error } : {}) }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  async list(limit = LIST_LIMIT): Promise<AutonomyTrace[]> {
    // store 的 find 不支持 orderBy：取回来自己排，避免依赖插入顺序
    const rows = await this.traces.find({})
    return rows.map(toTrace).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit)
  }

  async status(): Promise<AutonomyState> {
    return this.getState()
  }

  /** 世界状态：只取决策真正会用到的东西，别把快照做成全库扫描 */
  private async snapshot(now: Date): Promise<AutonomySnapshot> {
    const pending = await this.approval.list('pending')
    const runs = await this.task.list(20)
    const schedules = await this.schedule.list()
    const windowMs = this.config.upcomingWindowMinutes * 60_000
    const upcoming = schedules.filter(
      (item) => item.pausedAt === null && item.nextAt.getTime() - now.getTime() <= windowMs && item.nextAt.getTime() >= now.getTime(),
    )
    const dayAgo = now.getTime() - 24 * 3600_000
    return {
      at: now,
      pendingApprovals: pending.length,
      runningTasks: runs.filter((run) => run.status === 'running' || run.status === 'needs_approval').length,
      failedTasks: runs.filter((run) => run.status === 'failed' && (run.finishedAt?.getTime() ?? 0) >= dayAgo).length,
      upcomingSchedules: upcoming.length,
    }
  }

  private async candidates(snapshot: AutonomySnapshot, now: Date): Promise<AutonomyCandidate[]> {
    const list: AutonomyCandidate[] = []

    if (snapshot.pendingApprovals > 0) {
      const pending = await this.approval.list('pending')
      list.push({
        id: 'approval.pending',
        action: 'notify.self',
        title: `有 ${snapshot.pendingApprovals} 条待确认`,
        reason: `最早一条：${pending[0]?.prompt ?? '等你拍板'}`,
        value: 95,
        risk: 'low',
      })
    }

    if (snapshot.upcomingSchedules > 0) {
      const schedules = await this.schedule.list()
      const windowMs = this.config.upcomingWindowMinutes * 60_000
      const upcoming = schedules
        .filter((item) => item.pausedAt === null && item.nextAt.getTime() - now.getTime() <= windowMs && item.nextAt.getTime() >= now.getTime())
        .sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime())
      list.push({
        id: 'schedule.upcoming',
        action: 'notify.self',
        title: `${upcoming.length} 个日程在 ${this.config.upcomingWindowMinutes} 分钟内`,
        reason: `最近一条：「${upcoming[0]!.text}」将于 ${upcoming[0]!.nextAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 触发`,
        value: 80,
        risk: 'low',
        payload: { scheduleId: upcoming[0]!.id },
      })
    }

    if (snapshot.failedTasks > 0) {
      const runs = await this.task.list(20)
      const failed = runs.filter((run) => run.status === 'failed')
      const latest = failed[0]!
      list.push({
        id: 'task.failed',
        action: 'task.retry',
        title: `${snapshot.failedTasks} 个任务失败`,
        reason: `最近失败：${latest.title}（${(latest.error ?? '没有错误信息').slice(0, 80)}）`,
        value: 70,
        risk: 'medium',
        payload: { runId: latest.id },
      })
    }

    return list
  }

  private async getState(): Promise<AutonomyState> {
    const rows = await this.states.find({ limit: 1 })
    const row = rows[0]
    if (!row) {
      return { mode: this.config.mode, day: '', used: 0, lastTickAt: null, cooldowns: {} }
    }
    return {
      mode: (row.mode as AutonomyState['mode']) || this.config.mode,
      day: row.day,
      used: Number(row.used) || 0,
      lastTickAt: row.last_tick_at === null ? null : new Date(row.last_tick_at),
      cooldowns: parseJson<Record<string, number>>(row.cooldowns_json, {}),
    }
  }

  private async saveState(state: AutonomyState): Promise<void> {
    const rows = await this.states.find({ limit: 1 })
    const changes = {
      mode: state.mode,
      day: state.day,
      used: state.used,
      last_tick_at: state.lastTickAt ? state.lastTickAt.getTime() : null,
      cooldowns_json: JSON.stringify(state.cooldowns),
    }
    if (rows[0]) await this.states.update(rows[0].id, changes)
    else await this.states.insert({ id: 'state', ...changes })
  }

  /** 决策账本按保留期清理；每 5 分钟一条，不清会无限长 */
  private async prune(now: Date): Promise<void> {
    const days = this.config.retentionDays
    if (!days || days <= 0) return
    const cutoff = now.getTime() - days * 86_400_000
    const rows = await this.traces.find({})
    for (const row of rows) {
      if (row.at < cutoff) await this.traces.delete(row.id)
    }
  }

  private async appendTrace(trace: AutonomyTrace): Promise<void> {
    const at = Math.max(trace.at.getTime(), this.lastAt + 1)
    this.lastAt = at
    await this.traces.insert({
      id: trace.id,
      at,
      trigger: trace.trigger,
      mode: trace.mode,
      snapshot_json: JSON.stringify({ ...trace.snapshot, at: trace.snapshot.at.toISOString() }),
      candidates_json: JSON.stringify(trace.candidates),
      chosen_json: trace.chosen ? JSON.stringify(trace.chosen) : null,
      execution_json: trace.execution ? JSON.stringify(trace.execution) : null,
      suppressed_json: JSON.stringify(trace.suppressed),
      budget_json: JSON.stringify(trace.budget),
      reason: trace.reason,
    })
  }
}

function toTrace(row: TraceRow): AutonomyTrace {
  const snapshot = parseJson<Record<string, unknown>>(row.snapshot_json, {})
  return {
    id: row.id,
    at: new Date(row.at),
    trigger: row.trigger === 'manual' ? 'manual' : 'tick',
    mode: row.mode as AutonomyTrace['mode'],
    snapshot: {
      at: typeof snapshot.at === 'string' ? new Date(snapshot.at) : new Date(0),
      pendingApprovals: Number(snapshot.pendingApprovals) || 0,
      runningTasks: Number(snapshot.runningTasks) || 0,
      failedTasks: Number(snapshot.failedTasks) || 0,
      upcomingSchedules: Number(snapshot.upcomingSchedules) || 0,
    },
    candidates: parseJson<AutonomyCandidate[]>(row.candidates_json, []),
    chosen: row.chosen_json ? parseJson<AutonomyCandidate | null>(row.chosen_json, null) : null,
    execution: row.execution_json ? parseJson<AutonomyExecution | null>(row.execution_json, null) : null,
    suppressed: parseJson<{ id: string; reason: string }[]>(row.suppressed_json, []),
    budget: parseJson<AutonomyTrace['budget']>(row.budget_json, { day: '', limit: 0, used: 0 }),
    reason: row.reason,
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const LEVELS: Record<string, number> = { A0: 0, A1: 1, A2: 2, A3: 3 }

function levelOf(level: string): number {
  return LEVELS[level] ?? 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function dayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本地小时的静默窗口，支持跨零点（23 点–次日 8 点） */
function isQuiet(date: Date, start: number, end: number): boolean {
  const hour = date.getHours()
  if (start === end) return false
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
}

export function apply(ctx: Context, config: AutonomyConfig = {}): void {
  const runner = new AutonomyRunner(ctx, config)

  if (config.tickMs !== 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void runner.tick('tick').catch(() => undefined)
      }, config.tickMs ?? DEFAULTS.tickMs)
      timer.unref?.()
      return () => clearInterval(timer)
    })
  }

  const gateway = ctx.reflect.get('gateway', false) as GatewayService
  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/autonomy',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const status = await runner.status()
        res.status(200).send({
          ok: true,
          mode: status.mode,
          budget: { limit: config.dailyBudget ?? DEFAULTS.dailyBudget, used: status.used },
          lastTickAt: status.lastTickAt,
          items: await runner.list(),
        })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/autonomy/tick',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        res.status(200).send({ ok: true, trace: await runner.tick('manual') })
      },
    }),
  )
}

export const defaultExport = { name, inject, apply }
