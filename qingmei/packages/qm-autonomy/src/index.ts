/**
 * @qingmei/qm-autonomy —— 自主循环骨架（docs/13 §3，A1 建议模式）。
 *
 * 每 tick 一次：世界状态快照 → 规则候选 → 过滤（静默/预算/冷却）→ 选一条 → 记 decision trace。
 * A1 只产生建议，不执行动作；每条建议都带理由，Web 的「主动」面板可回看。
 *
 * 存储与循环放在同一个插件里：`qm_*` 是业务编排，自己的集合自己管（与 qm-history 一致）。
 */
import { Service, type Context } from 'cordis'
import {
  AUTONOMY_ACTIONS,
  AutonomyService,
  EVENTS,
  uid,
  type ApprovalService,
  type AutonomyExecution,
  type AutonomyLevel,
  type AutonomyCandidate,
  type AutonomyComplaintInput,
  type AutonomyRollbackInput,
  type AutonomyRollbackResult,
  type AutonomyComplaintResult,
  type AutonomySnapshot,
  type AutonomyState,
  type AutonomyTrace,
  type GatewayRequest,
  type GatewayResponse,
  type ChannelService,
  type MemoryService,
  type ChannelTargetService,
  type GatewayService,
  type Row,
  type StoreService,
  type TaskService,
  type TaskRunnerService,
  type TaskRun,
} from '@qingmei/core'

export interface AutonomyConfig {
  /** tick 间隔；0 表示只手动触发（测试用） */
  tickMs?: number
  /** 是否装配同包自治子模块 */
  modules?: boolean
  mode?: AutonomyLevel
  /** 每日主动建议上限；0 = 不限量（只受静默时段与单规则冷却约束） */
  dailyBudget?: number
  /** 每日自省：生成一条「想法」候选；false 关闭 */
  reflection?: boolean
  /** 自省从几点开始（本地小时） */
  reflectionHour?: number
  /** 自省冷却，默认 20 小时（一天一次） */
  reflectionCooldownMinutes?: number
  /** 测试用时钟 */
  clock?: () => Date
  /** 静默时段（本地小时，左闭右开，可跨零点） */
  quietStart?: number
  quietEnd?: number
  /** 同一规则的冷却分钟数 */
  cooldownMinutes?: number
  /** 日程「即将开始」的前瞻窗口 */
  upcomingWindowMinutes?: number
  /** 决策账本保留天数；0 表示不清理 */
  retentionDays?: number
  /** 建议发出后多久内收到消息算「被采纳」 */
  acceptWindowMinutes?: number
  /** 连续采纳多少次可以升一级 */
  upgradeAfter?: number
  /** 同一规则被忽略多少次后冷却翻倍 */
  ignoreBeforeSlowdown?: number
  /** 连续采纳后自动升级（默认关闭：升级要人点头） */
  autoUpgrade?: boolean
  /** 锁死当前级别：忽略升级 */
  trustLocked?: boolean
  /** 同一规则被忽略多少次后只进摘要 */
  digestAfter?: number
  /** 每天几点发摘要（本地小时） */
  digestHour?: number
  /** 主动消息路由：work 默认飞书，casual 默认 QQ */
  notify?: {
    default?: NotifyRoute
    work?: NotifyRoute
    casual?: NotifyRoute
    digest?: NotifyRoute
  }
}

export interface NotifyRoute {
  channel: string
  conversationId: string
}

export const name = 'qm-autonomy'
export const inject = ['store', 'approval', 'task', 'gateway', 'channel', 'taskRunner']

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
  acceptWindowMinutes: 30,
  upgradeAfter: 10,
  ignoreBeforeSlowdown: 3,
  autoUpgrade: false,
  trustLocked: false,
  digestAfter: 6,
  digestHour: 20,
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
  accepted?: number
  ignored?: number
  streak?: number
  pending_json?: string | null
  ignored_by_rule_json?: string
  locked?: boolean
  digest_json?: string
  complaints?: number
  last_complaint_at?: number | null
}

class AutonomyRunner extends AutonomyService {
  private readonly config: Required<AutonomyConfig>
  private readonly traces
  private readonly states
  private readonly approval: ApprovalService
  private readonly task: TaskService
  private readonly gateway: GatewayService
  private readonly channel: ChannelService
  private readonly taskRunner: TaskRunnerService
  private memory: MemoryService | undefined
  private channelTargets: ChannelTargetService | undefined
  private lastAt = 0

  constructor(ctx: Context, config: AutonomyConfig = {}) {
    super(ctx)
    this.config = { ...DEFAULTS, ...config } as Required<AutonomyConfig>
    const store = ctx.store
    this.approval = ctx.approval
    this.task = ctx.task
    this.gateway = ctx.gateway
    this.channel = ctx.channel
    this.taskRunner = ctx.taskRunner
    ctx.inject(['channelTargets'], (sub) => { this.channelTargets = sub.channelTargets })
    ctx.inject(['memory'], (sub) => { this.memory = sub.memory })
    this.traces = store.collection<TraceRow>(TRACE)
    this.states = store.collection<StateRow>(STATE)
  }

  /** 状态读改写串行化：tick 与「收到消息」可能同时改同一份状态 */
  private stateQueue: Promise<unknown> = Promise.resolve()

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stateQueue.then(fn, fn)
    this.stateQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async tick(trigger: 'tick' | 'manual'): Promise<AutonomyTrace> {
    return this.serialize(() => this.tickInner(trigger))
  }

  private async tickInner(trigger: 'tick' | 'manual'): Promise<AutonomyTrace> {
    const now = this.config.clock ? this.config.clock() : new Date()
    const state = await this.getState()
    const day = dayKey(now)
    if (state.day !== day) {
      state.day = day
      state.used = 0
    }

    // 上一条建议过了回应窗口还没人理：记一次忽略，连续采纳中断
    if (state.pending && now.getTime() > state.pending.expiresAt) {
      state.ignored += 1
      state.streak = 0
      state.ignoredByRule[state.pending.candidateId] = (state.ignoredByRule[state.pending.candidateId] ?? 0) + 1
      state.pending = null
    }

    const snapshot = await this.snapshot(now)
    const candidates = await this.candidates(snapshot, now)
    const suppressed: { id: string; reason: string }[] = []
    let chosen: AutonomyCandidate | null = null
    let reason = ''

    // 被忽略太多次的规则不再即时打扰：进摘要队列，等每天一次汇总
    const immediate: AutonomyCandidate[] = []
    for (const candidate of candidates) {
      if ((state.ignoredByRule[candidate.id] ?? 0) >= this.config.digestAfter) {
        if (!state.digest.items.some((item) => item.id === candidate.id)) {
          state.digest.items.push({ id: candidate.id, title: candidate.title, reason: candidate.reason, at: now.getTime() })
          if (state.digest.items.length > 20) state.digest.items.shift()
        }
        suppressed.push({ id: candidate.id, reason: '已降级到摘要' })
        continue
      }
      immediate.push(candidate)
    }

    const quiet = isQuiet(now, this.config.quietStart, this.config.quietEnd)
    if (quiet) {
      for (const candidate of immediate) suppressed.push({ id: candidate.id, reason: '静默时段' })
      reason = `静默时段（${this.config.quietStart}:00–${this.config.quietEnd}:00），只记录不说话`
    } else if (state.mode === 'A0') {
      for (const candidate of immediate) suppressed.push({ id: candidate.id, reason: 'A0 观察模式' })
      reason = 'A0 观察模式：只记录，不动作'
    } else if (this.config.dailyBudget > 0 && state.used >= this.config.dailyBudget) {
      for (const candidate of immediate) suppressed.push({ id: candidate.id, reason: '今日预算用完' })
      reason = `今日建议已用 ${state.used}/${this.config.dailyBudget}，不再打扰`
    } else {
      const allowed: AutonomyCandidate[] = []
      for (const candidate of immediate) {
        const until = state.cooldowns[candidate.id] ?? 0
        if (until > now.getTime()) {
          suppressed.push({ id: candidate.id, reason: `冷却中（至 ${new Date(until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）` })
          continue
        }
        allowed.push(candidate)
      }
      if (allowed.length === 0) {
        reason =
          candidates.length === 0
            ? '没有值得打扰的事'
            : immediate.length === 0
              ? '候选都已降级到摘要'
              : '候选都在冷却中'
      } else {
        chosen = allowed.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))[0]!
        state.used += 1
        const ignoredTimes = state.ignoredByRule[chosen.id] ?? 0
        // 忽略得越多，冷却越长；这是 docs/13 §10 的「降频」在 P1 的近似
        const slowFactor = ignoredTimes >= this.config.ignoreBeforeSlowdown ? 2 : 1
        const cooldownMinutes = chosen.id === 'reflection.thought'
          ? (this.config.reflectionCooldownMinutes ?? 1200)
          : this.config.cooldownMinutes
        state.cooldowns[chosen.id] = now.getTime() + cooldownMinutes * slowFactor * 60_000
        reason = chosen.reason
      }
    }

    // 清理过期冷却，避免状态无限膨胀
    for (const [id, until] of Object.entries(state.cooldowns)) {
      if (until <= now.getTime()) delete state.cooldowns[id]
    }
    const traceId = uid('aut')
    state.lastTickAt = now

    // 选中后要真的处理：能执行就执行，级别不够就降级成建议——但都要留回执
    const execution = chosen ? await this.execute(chosen, now, state.mode) : null

    // 发出去的建议进入「等回应」：窗口内有人说话就算采纳，过了窗口下一次 tick 记忽略
    if (
      chosen &&
      execution &&
      execution.action === 'notify.self' &&
      (execution.status === 'executed' || execution.status === 'suggested')
    ) {
      state.pending = {
        traceId,
        candidateId: chosen.id,
        at: now.getTime(),
        expiresAt: now.getTime() + this.config.acceptWindowMinutes * 60_000,
      }
    }

    // 连续采纳到阈值：默认只记账（升级要人点头），autoUpgrade 打开才真的升
    let upgraded = false
    if (
      this.config.autoUpgrade &&
      !this.config.trustLocked &&
      !state.locked &&
      state.mode === 'A1' &&
      state.streak >= this.config.upgradeAfter
    ) {
      state.mode = 'A2'
      upgraded = true
    }

    await this.saveState(state)
    if (upgraded) {
      await this.notify(`🎉 连续 ${state.streak} 次采纳，已升到 A2：以后失败任务可以自己重试`)
    }

    // 摘要每天最多发一次：到点、有积压、今天还没发过
    if (now.getHours() >= this.config.digestHour && state.digest.items.length > 0 && state.digest.day !== day) {
      const sent = await this.sendDigest(state.digest.items)
      if (sent) {
        state.digest = { day, items: [] }
        await this.saveState(state)
      }
    }

    const trace: AutonomyTrace = {
      id: traceId,
      at: now,
      trigger,
      mode: state.mode,
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
  private async execute(chosen: AutonomyCandidate, at: Date, mode: AutonomyLevel): Promise<AutonomyExecution> {
    const spec = AUTONOMY_ACTIONS[chosen.action]
    if (!spec) {
      return { status: 'skipped', action: chosen.action, detail: '不在行动白名单，拒绝执行', at }
    }
    if (!spec.reversible) {
      return { status: 'skipped', action: chosen.action, detail: '不可逆动作必须人工确认，自主循环不执行', at }
    }

    if (levelOf(mode) < levelOf(spec.minLevel)) {
      if (mode === 'A0') {
        return { status: 'skipped', action: chosen.action, detail: `需要 ${spec.minLevel}，A0 只记录`, at }
      }
      // 级别不够：至少把「建议」发出去，让人有机会点头
      const sent = await this.notify(`💡 ${chosen.title}\n${chosen.reason}`)
      if (sent.ok) void this.recordSuggestion(chosen)
      return sent.ok
        ? { status: 'suggested', action: 'notify.self', detail: `需要 ${spec.minLevel}，当前 ${mode}：已按建议发出`, at }
        : { status: 'failed', action: 'notify.self', detail: `建议发送失败：${sent.error ?? '未知原因'}`, at }
    }

    if (chosen.action === 'notify.self') {
      const sent = await this.notify(`💡 ${chosen.title}\n${chosen.reason}`)
      if (sent.ok) void this.recordSuggestion(chosen)
      return sent.ok
        ? { status: 'executed', action: 'notify.self', detail: '已发到主人私聊', at }
        : { status: 'failed', action: 'notify.self', detail: `发送失败：${sent.error ?? '未知原因'}`, at }
    }

    if (chosen.action === 'task.create') {
      const prompt = String(chosen.payload?.prompt ?? '').trim()
      const title = String(chosen.payload?.title ?? chosen.title).trim()
      if (!prompt || !title) {
        return { status: 'skipped', action: 'task.create', detail: '缺少 prompt/title', at }
      }
      const dayStart = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
      const existing = (await this.task.list(30)).filter(
        (run) => run.title === title && run.createdAt.getTime() >= dayStart,
      )
      if (existing.length > 0) {
        return { status: 'skipped', action: 'task.create', detail: `「${title}」今天已经建过`, at }
      }
      try {
        const run = await this.task.create({ prompt, title, priority: 5 })
        return { status: 'executed', action: 'task.create', detail: `已创建任务 ${run.id}`, runId: run.id, at }
      } catch (error) {
        return { status: 'failed', action: 'task.create', detail: `创建失败：${messageOf(error)}`, at }
      }
    }
    if (chosen.action === 'task.retry') {
      const runId = typeof chosen.payload?.runId === 'string' ? chosen.payload.runId : ''
      const original = runId ? await this.task.get(runId) : null
      if (!original) {
        return { status: 'failed', action: 'task.retry', detail: '找不到要重试的原任务', at }
      }
      // 只重试「原始任务」一次：重试出来的再失败也不再重试，
      // 否则失败会沿「重试：重试：…」一路滚下去。
      if (original.retryOf) {
        return { status: 'skipped', action: 'task.retry', detail: '这条本身是重试，不再继续重试', at }
      }
      const retryTitle = `重试：${original.title}`
      const finishedAt = original.finishedAt?.getTime() ?? 0
      const already = (await this.task.list(50)).some(
        (run) => run.retryOf === original.id || (run.title === retryTitle && run.createdAt.getTime() >= finishedAt),
      )
      if (already) {
        return { status: 'skipped', action: 'task.retry', detail: `「${original.title}」已经重试过，不再重复派发`, at }
      }
      try {
        const run = await this.task.create({
          prompt: original.prompt,
          title: retryTitle,
          retryOf: original.id,
          // 原任务是什么目标就还派到哪里：设备任务不能因为重试悄悄跑到服务器上
          ...(original.target ? { target: original.target } : {}),
          ...(original.priority !== undefined ? { priority: original.priority } : {}),
          ...(original.contract ? { contract: original.contract } : {}),
        })
        this.taskRunner.dispatch(run)
        return { status: 'executed', action: 'task.retry', detail: `已重新派发 ${run.id}`, runId: run.id, at }
      } catch (error) {
        return { status: 'failed', action: 'task.retry', detail: `派发失败：${messageOf(error)}`, at }
      }
    }

    return { status: 'skipped', action: chosen.action, detail: '这个动作还没有执行器', at }
  }

  private async sendDigest(items: { id: string; title: string; reason: string }[]): Promise<boolean> {
    const lines = items.map((item) => `- ${item.title}：${item.reason}`).join('\n')
    const sent = await this.notify(`📥 今日摘要（${items.length} 条）\n${lines}`)
    return sent.ok
  }

  /** 手动把积压的摘要发出去（测试与「现在发」入口） */
  async flushDigest(): Promise<{ sent: number; ok: boolean }> {
    return this.serialize(async () => {
      const state = await this.getState()
      if (state.digest.items.length === 0) return { sent: 0, ok: false }
      const items = state.digest.items
      const ok = await this.sendDigest(items)
      if (ok) {
        state.digest = { day: dayKey(new Date()), items: [] }
        await this.saveState(state)
      }
      return { sent: ok ? items.length : 0, ok }
    })
  }

  /** 主动建议也进任务账本：proposed 状态，工作台可见 */
  private async recordSuggestion(chosen: { title: string; reason: string }): Promise<void> {
    await this.task
      .create({
        title: chosen.title.slice(0, 60),
        prompt: `${chosen.title}\n${chosen.reason}`.slice(0, 500),
        kind: 'suggestion',
        status: 'proposed',
        origin: 'autonomy',
      })
      .catch(() => undefined)
  }

  private async notify(text: string, kind: 'work' | 'casual' | 'digest' = 'casual'): Promise<{ ok: boolean; error?: string }> {
    try {
      let route = this.config.notify?.[kind] ?? this.config.notify?.default
      if (!route) {
        const preferred = kind === 'casual' ? ('qq' as const) : ('feishu' as const)
        const target = (await this.channelTargets?.list() ?? []).find((row) => row.channel === preferred)
        if (target) route = { channel: preferred, conversationId: target.conversationId }
      }
      const result = await this.channel.send({
        channel: (route?.channel ?? 'web') as never,
        conversationId: route?.conversationId ?? 'owner',
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

  /** 即将到点的定时任务：日程已经并入任务账本，不再读 qm_schedule */
  private async scheduledUpcoming(now: Date): Promise<Array<{ nextAt: Date; text: string }>> {
    const runs = await this.task.list(200)
    const windowMs = this.config.upcomingWindowMinutes * 60_000
    return runs
      .filter((run) => run.status === 'scheduled' && run.schedule?.at)
      .map((run) => ({ nextAt: run.schedule!.at!, text: run.title }))
      .filter((item) => item.nextAt.getTime() - now.getTime() <= windowMs && item.nextAt.getTime() >= now.getTime())
      .sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime())
  }

  /** 世界状态：只取决策真正会用到的东西，别把快照做成全库扫描 */
  private async snapshot(now: Date): Promise<AutonomySnapshot> {
    const pending = await this.approval.list('pending')
    const runs = await this.task.list(20)
    const upcoming = await this.scheduledUpcoming(now)
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
      const upcoming = await this.scheduledUpcoming(now)
      list.push({
        id: 'schedule.upcoming',
        action: 'notify.self',
        title: `${upcoming.length} 个日程在 ${this.config.upcomingWindowMinutes} 分钟内`,
        reason: `最近一条：「${upcoming[0]!.text}」将于 ${upcoming[0]!.nextAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 触发`,
        value: 80,
        risk: 'low',
      })
    }

    if (this.memory) {
      const stats = await this.memory.stats().catch(() => null)
      if (stats && Number(stats.episodes) >= 3 && Number(stats.concepts) === 0) {
        list.push({
          id: 'memory.consolidate.suggest',
          action: 'notify.self',
          title: '记忆可以沉淀了',
          reason: '已经有多个事件但没有概念神经元；建议手动触发一次记忆整理',
          value: 55,
          risk: 'low',
          payload: { stats },
        })
      }
    }

    if (this.memory) {
      const proposals = await this.memory.conceptProposals().catch(() => [])
      if (proposals.length > 0) {
        list.push({
          id: 'memory.concept.review',
          action: 'notify.self',
          title: `${proposals.length} 条概念变更待评估`,
          reason: '概念合并/分裂只发提案，不自动执行；可在记忆页评估后应用',
          value: 50,
          risk: 'low',
          payload: { proposals: proposals.slice(0, 3) },
        })
      }
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

    if (this.config.reflection === true && now.getHours() >= (this.config.reflectionHour ?? 9)) {
      const runs = await this.task.list(30)
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const failedToday = runs.filter((run) => run.status === 'failed' && (run.finishedAt?.getTime() ?? 0) >= dayStart)
      const doneWeek = runs.filter(
        (run) => run.status === 'done' && (run.finishedAt?.getTime() ?? 0) >= now.getTime() - 7 * 86_400_000,
      )
      const lastActive = runs.reduce((latest, run) => Math.max(latest, run.finishedAt?.getTime() ?? 0), 0)
      if (failedToday.length > 0) {
        const target = failedToday[0]!
        list.push({
          id: 'reflection.thought',
          action: 'task.create',
          title: `给「${target.title}」一次补救`,
          reason: `今天它失败了：${(target.error ?? '未知原因').slice(0, 60)}。重试时先定位原因，再决定怎么做`,
          value: 72,
          risk: 'medium',
          payload: {
            title: `补救：${target.title}`,
            prompt: `${target.prompt}\n\n上次失败原因：${target.error ?? '未知'}\n先说明原因与改法，再决定是否执行。`,
          },
        })
      } else if (snapshot.upcomingSchedules > 0) {
        list.push({
          id: 'reflection.thought',
          action: 'notify.self',
          title: '今天的安排要不要提前过一遍',
          reason: `接下来 ${this.config.upcomingWindowMinutes} 分钟内有日程，提前准备一下更稳`,
          value: 60,
          risk: 'low',
        })
      } else if (doneWeek.length >= 3) {
        list.push({
          id: 'reflection.thought',
          action: 'notify.self',
          title: '最近完成的事可以沉淀成技能',
          reason: `7 天内完成了 ${doneWeek.length} 个任务，可以把做法整理成技能，下次少走弯路`,
          value: 60,
          risk: 'low',
        })
      } else if (lastActive > 0 && now.getTime() - lastActive > 3 * 86_400_000) {
        list.push({
          id: 'reflection.thought',
          action: 'notify.self',
          title: '有几天没一起做事了',
          reason: '最近三天没有任务收尾，可以聊聊接下来做什么',
          value: 58,
          risk: 'low',
        })
      }
    }

    return list
  }

  private async getState(): Promise<AutonomyState> {
    const rows = await this.states.find({ limit: 1 })
    const row = rows[0]
    if (!row) {
      return {
        mode: this.config.mode,
        day: '',
        used: 0,
        lastTickAt: null,
        cooldowns: {},
        accepted: 0,
        ignored: 0,
        streak: 0,
        pending: null,
        ignoredByRule: {},
        locked: false,
        digest: { day: '', items: [] },
        complaints: 0,
        lastComplaintAt: null,
      }
    }
    return {
      mode: (row.mode as AutonomyState['mode']) || this.config.mode,
      day: row.day,
      used: Number(row.used) || 0,
      lastTickAt: row.last_tick_at === null ? null : new Date(row.last_tick_at),
      cooldowns: parseJson<Record<string, number>>(row.cooldowns_json, {}),
      accepted: Number(row.accepted) || 0,
      ignored: Number(row.ignored) || 0,
      streak: Number(row.streak) || 0,
      pending: parseJson<AutonomyState['pending']>(row.pending_json ?? null, null),
      ignoredByRule: parseJson<Record<string, number>>(row.ignored_by_rule_json ?? null, {}),
      locked: Boolean(row.locked),
      digest: parseJson<AutonomyState['digest']>(row.digest_json ?? null, { day: '', items: [] }),
      complaints: Number(row.complaints) || 0,
      lastComplaintAt: row.last_complaint_at ? new Date(row.last_complaint_at) : null,
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
      accepted: state.accepted,
      ignored: state.ignored,
      streak: state.streak,
      pending_json: state.pending ? JSON.stringify(state.pending) : null,
      ignored_by_rule_json: JSON.stringify(state.ignoredByRule),
      locked: state.locked,
      digest_json: JSON.stringify(state.digest),
      complaints: state.complaints ?? 0,
      last_complaint_at: state.lastComplaintAt ? state.lastComplaintAt.getTime() : null,
    }
    if (rows[0]) await this.states.update(rows[0].id, changes)
    else await this.states.insert({ id: 'state', ...changes })
  }

  /** 收到一条入站消息：如果最近有等待回应的建议，就算被采纳 */
  async noteEngagement(): Promise<void> {
    return this.serialize(() => this.noteEngagementInner())
  }

  /** 主人手动设置级别/锁死：优先于配置文件，也优先于自动升级 */
  async setTrust(input: { level?: AutonomyLevel; locked?: boolean }): Promise<AutonomyState> {
    return this.serialize(async () => {
      const state = await this.getState()
      if (input.level) state.mode = input.level
      if (typeof input.locked === 'boolean') state.locked = input.locked
      await this.saveState(state)
      return state
    })
  }

  /**
   * A5 投诉/回滚：记录一次投诉，并降一级（A3 → A2 → A1 → A0）。
   * locked 时只记录不改级别；降级后清掉待回应的建议，避免旧建议继续计采纳。
   */
  async complain(input: AutonomyComplaintInput = {}): Promise<AutonomyComplaintResult> {
    return this.serialize(async () => {
      const state = await this.getState()
      const before = state.mode
      state.complaints = (state.complaints ?? 0) + 1
      state.lastComplaintAt = new Date()
      state.streak = 0
      state.pending = null

      const order: AutonomyLevel[] = ['A0', 'A1', 'A2', 'A3']
      const index = order.indexOf(before)
      const after = !state.locked && index > 0 ? order[index - 1]! : before
      state.mode = after
      await this.saveState(state)

      if (after !== before) {
        void this.notify(`📉 收到投诉${input.reason ? `（${input.reason}）` : ''}，主动级别 ${before} → ${after}`)
      } else if (state.locked) {
        void this.notify('📉 收到投诉；当前级别已锁定，未自动降级')
      }
      return { before, after, complaints: state.complaints, locked: state.locked }
    })
  }
  /**
   * A5 回滚：只回滚已执行的可逆动作（notify.self 无副作用；task.retry/harness.dispatch 取消派生的 run）。
   * 与投诉共用降级语义：回滚一次也降一级，并把 trace 的执行状态改成 rolled_back。
   */
  async rollback(input: AutonomyRollbackInput = {}): Promise<AutonomyRollbackResult> {
    return this.serialize(async () => {
      const state = await this.getState()
      const before = state.mode
      const rows = await this.traces.find({})
      const traces = rows.map(toTrace).sort((a, b) => b.at.getTime() - a.at.getTime())
      const target = input.traceId
        ? traces.find((trace) => trace.id === input.traceId)
        : traces.find((trace) => trace.execution?.status === 'executed')
      if (!target?.execution || target.execution.status !== 'executed') {
        return { ok: false, before, after: before, error: '没有可回滚的已执行动作' }
      }

      const action = target.execution.action
      if (!AUTONOMY_ACTIONS[action]?.reversible) {
        return { ok: false, before, after: before, error: `动作 ${action} 不可回滚` }
      }

      if (action === 'task.retry' || action === 'harness.dispatch') {
        const runId = target.execution.runId
        const run = runId ? await this.task.get(runId) : null
        if (run && (run.status === 'done' || run.status === 'failed')) {
          return { ok: false, before, after: before, error: '派生任务已结束，无法撤回' }
        }
        if (run && run.status !== 'cancelled') {
          const cancelled = await this.taskRunner.cancel(runId!, '被主人回滚')
          if (!cancelled) return { ok: false, before, after: before, error: '派生任务无法取消' }
        }
      }

      const row = rows.find((item) => item.id === target.id)
      if (row) {
        await this.traces.update(row.id, {
          execution_json: JSON.stringify({
            ...target.execution,
            status: 'rolled_back',
            detail: `${target.execution.detail}（已回滚）`,
          }),
        })
      }

      const order: AutonomyLevel[] = ['A0', 'A1', 'A2', 'A3']
      const index = order.indexOf(before)
      const after = !state.locked && index > 0 ? order[index - 1]! : before
      state.mode = after
      state.complaints = (state.complaints ?? 0) + 1
      state.lastComplaintAt = new Date()
      state.streak = 0
      state.pending = null
      await this.saveState(state)

      void this.notify(
        `↩️ 已回滚 ${action}${input.reason ? `（${input.reason}）` : ''}${after !== before ? `，主动级别 ${before} → ${after}` : ''}`,
      )
      return { ok: true, traceId: target.id, action, before, after }
    })
  }
  private async noteEngagementInner(): Promise<void> {
    const state = await this.getState()
    if (!state.pending) return
    if (Date.now() > state.pending.expiresAt) return
    state.accepted += 1
    state.streak += 1
    state.pending = null
    await this.saveState(state)
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

import * as incidentModule from './modules/incident.ts'
import * as nudgeModule from './modules/nudge.ts'
import * as openerModule from './modules/opener.ts'
import * as restModule from './modules/rest.ts'
import * as profileModule from './modules/conversation-profile.ts'

interface IncidentStatRow extends Row {
  status: string
  first_at: number
}

/** 故障统计（只读）：qm_incident 的 owner 是本包的 modules/incident，复盘通过这个服务取数 */
class IncidentStats extends Service {
  private readonly collection

  constructor(ctx: Context) {
    super(ctx, 'incidentStats')
    this.collection = ctx.store.collection<IncidentStatRow>('qm_incident')
  }

  async stats(query: { since?: Date; until?: Date } = {}): Promise<{ total: number; open: number; fused: number }> {
    const since = query.since?.getTime() ?? 0
    const until = query.until?.getTime() ?? Number.MAX_SAFE_INTEGER
    const rows = (await this.collection.find({})).filter((row) => row.first_at >= since && row.first_at <= until)
    return {
      total: rows.length,
      open: rows.filter((row) => row.status === 'open' || row.status === 'proposed').length,
      fused: rows.filter((row) => row.status === 'fused').length,
    }
  }
}
export function apply(ctx: Context, config: AutonomyConfig = {}): void {
  const runner = new AutonomyRunner(ctx, config)
  // 故障账本由本包（modules/incident）拥有；给复盘提供只读统计，别让别的插件直接读表
  new IncidentStats(ctx)
  // 自治能力统一装配：主动建议、故障提案、督促、开场、休息、群策略
  if (config.modules) {
    ctx.plugin(incidentModule, {})
    ctx.plugin(nudgeModule, {})
    ctx.plugin(openerModule, {})
    ctx.plugin(restModule, {})
    ctx.plugin(profileModule, {})
  }

  if (config.tickMs !== 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void runner.tick('tick').catch(() => undefined)
      }, config.tickMs ?? DEFAULTS.tickMs)
      timer.unref?.()
      return () => clearInterval(timer)
    })
  }

  // 盘点任务收尾后把结论回推给主人：这是 A3 的「汇报」环节
  const channel = ctx.channel
  if (channel) {
    ctx.events.on(EVENTS.taskFinished, (run: TaskRun) => {
      if (run.kind !== 'inventory') return
      const text = `📋 盘点完成（${run.project ?? '项目'}）：${run.result ?? run.error ?? '没有结论'}`
      void channel
        .send({ channel: 'web', conversationId: 'owner', blocks: [{ type: 'text', text }] })
        .catch(() => undefined)
    })
  }

  // 收到入站消息：如果最近有一条等回应的建议，就算被采纳（P1 的近似信号）
  ctx.events.on(EVENTS.inbound, () => {
    void runner.noteEngagement()
  })

  const gateway = ctx.gateway
  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/autonomy',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const status = await runner.status()
        res.status(200).send({
          ok: true,
          mode: status.mode,
          locked: status.locked,
          budget: { limit: config.dailyBudget ?? DEFAULTS.dailyBudget, used: status.used },
          trust: {
            accepted: status.accepted,
            ignored: status.ignored,
            streak: status.streak,
            complaints: status.complaints ?? 0,
          },
          digest: { count: status.digest.items.length },
          lastTickAt: status.lastTickAt,
          items: await runner.list(),
        })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/autonomy/trust',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const raw = typeof body.level === 'string' ? body.level.trim() : ''
        const locked = typeof body.locked === 'boolean' ? body.locked : undefined
        if (!raw && locked === undefined) {
          res.status(400).send({ ok: false, error: 'level 或 locked 至少给一个' })
          return
        }
        if (raw && !['A0', 'A1', 'A2', 'A3'].includes(raw)) {
          res.status(400).send({ ok: false, error: 'level 只能是 A0 / A1 / A2 / A3' })
          return
        }
        const state = await runner.setTrust({
          ...(raw ? { level: raw as AutonomyLevel } : {}),
          ...(locked !== undefined ? { locked } : {}),
        })
        res.status(200).send({ ok: true, mode: state.mode, locked: state.locked })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/autonomy/complaint',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
        if (reason.length > 200) {
          res.status(400).send({ ok: false, error: 'reason 最多 200 字' })
          return
        }
        const result = await runner.complain({
          ...(reason ? { reason } : {}),
          ...(typeof body.traceId === 'string' && body.traceId.trim() ? { traceId: body.traceId.trim() } : {}),
        })
        res.status(200).send({ ok: true, ...result })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/autonomy/rollback',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const result = await runner.rollback({
          ...(typeof body.traceId === 'string' && body.traceId.trim() ? { traceId: body.traceId.trim() } : {}),
          ...(typeof body.reason === 'string' && body.reason.trim() ? { reason: body.reason.trim() } : {}),
        })
        res.status(result.ok ? 200 : 400).send(result)
      },
    }),
  )
  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/autonomy/digest',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const result = await runner.flushDigest()
        if (!result.ok) {
          res.status(400).send({ ok: false, error: '没有待发的摘要' })
          return
        }
        res.status(200).send({ ok: true, sent: result.sent })
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













