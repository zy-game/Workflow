/**
 * 自规划循环：任务结束后（以及手动触发）读目标账本 + 最近任务，让模型决定下一步。
 *
 * 输出只允许四类动作：建一个后续任务、发一条提醒、申请做资料研究、什么都不做。
 * 所有写动作都受日限/深度/去重约束；研究申请走审批，批准后才建任务。
 */
import { Service, type Context } from 'cordis'
import {
  EVENTS,
  type ApprovalRequest,
  type ApprovalService,
  type ChannelId,
  type ChannelService,
  type Collection,
  type GatewayService,
  type HarnessService,
  type Row,
  type TaskRun,
  type TaskService,
} from '@qingmei/core'

export const name = 'qm-planner'
export const inject = ['store', 'task', 'gateway']

export interface PlannerConfig {
  /** 总开关；默认关，避免升级后突然开始花钱 */
  enabled?: boolean
  /** 自建任务每天上限 */
  maxSelfTasksPerDay?: number
  /** 自建任务链深度上限（1 = 自建任务完成后只允许提醒/申请） */
  maxDepth?: number
  /** 定时/其他触发的 replan 最小间隔（分钟） */
  cooldownMinutes?: number
  /** 任务结束触发的 replan 间隔（分钟）：任务刚失败/完成时应该立刻能规划 */
  taskCooldownMinutes?: number
  /** 注入上下文的最近任务条数 */
  historyLimit?: number
  /** 注入上下文的目标条数 */
  goalLimit?: number
  /** 提醒发到哪个渠道/会话 */
  notifyChannel?: ChannelId
  notifyConversation?: string
  /** 研究申请默认时长（分钟） */
  researchMinutes?: number
  /** 规划会话的工作目录 */
  cwd?: string
  /** 复用哪个 DSH 会话：默认就是聊天用的 owner 会话，保证只有一个脑子 */
  sessionId?: string
}

const GOALS = 'qm_goal'
const RUNS = 'qm_planner_run'
const REQUESTS = 'qm_planner_request'

const DEFAULTS = {
  enabled: false,
  maxSelfTasksPerDay: 3,
  maxDepth: 1,
  cooldownMinutes: 30,
  taskCooldownMinutes: 5,
  historyLimit: 10,
  goalLimit: 10,
  notifyChannel: 'web' as ChannelId,
  notifyConversation: 'owner',
  researchMinutes: 10,
  cwd: '',
  sessionId: 's_owner',
}

export interface Goal {
  id: string
  title: string
  why: string
  status: 'active' | 'paused' | 'done'
  nextStep: string
  createdBy: 'user' | 'planner'
  evidence: string[]
  lastTouched: Date
  createdAt: Date
}

interface GoalRow extends Row {
  title: string
  why: string
  status: string
  next_step: string
  created_by: string
  evidence_json: string
  last_touched: number
  created_at: number
}

interface PlannerRunRow extends Row {
  at: number
  trigger: string
  action: string
  task_id: string | null
  title: string | null
  why: string | null
  evidence_json: string
  depth: number
  status: string
}

interface RequestRow extends Row {
  approval_id: string
  topic: string
  why: string
  minutes: number
  status: string
  task_id: string | null
  at: number
}

export interface PlannerStats {
  windowDays: number
  runs: number
  tasksCreated: number
  tasksDone: number
  reminders: number
  skips: number
  researchRequested: number
  researchApproved: number
  researchRejected: number
  acceptance: number
}

interface PlanNextTask {
  prompt: string
  title: string
  why?: string
  evidence?: string[]
}

interface PlanReminder {
  text: string
  why?: string
}

interface PlanResearch {
  topic: string
  why?: string
  minutes?: number
}

interface Plan {
  nextTask: PlanNextTask | null
  reminder: PlanReminder | null
  research: PlanResearch | null
  skip: string | null
}

interface PlannerDeps {
  goals: Collection<GoalRow>
  runs: Collection<PlannerRunRow>
  requests: Collection<RequestRow>
  task: () => TaskService | undefined
  harness: () => HarnessService | undefined
  channel: () => ChannelService | undefined
  approval: () => ApprovalService | undefined
}

class PlannerService extends Service {
  readonly config: Required<PlannerConfig>
  readonly deps: PlannerDeps
  constructor(ctx: Context, deps: PlannerDeps, config: PlannerConfig) {
    super(ctx, 'planner')
    this.deps = deps
    this.config = { ...DEFAULTS, ...config }
  }

  async listGoals(status?: Goal['status']): Promise<Goal[]> {
    const rows = (await this.deps.goals.find({})) as GoalRow[]
    return rows
      .filter((row) => (status ? row.status === status : true))
      .sort((a, b) => b.last_touched - a.last_touched)
      .map(toGoal)
  }

  async createGoal(input: {
    title: string
    why?: string
    nextStep?: string
    createdBy?: Goal['createdBy']
    evidence?: string[]
  }): Promise<Goal> {
    const now = Date.now()
    const row = (await this.deps.goals.insert({
      title: input.title.trim().slice(0, 120),
      why: (input.why ?? '').trim().slice(0, 500),
      status: 'active',
      next_step: (input.nextStep ?? '').trim().slice(0, 300),
      created_by: input.createdBy ?? 'user',
      evidence_json: JSON.stringify(input.evidence ?? []),
      last_touched: now,
      created_at: now,
    })) as GoalRow
    return toGoal(row)
  }

  async updateGoal(
    id: string,
    patch: Partial<Pick<Goal, 'title' | 'why' | 'status' | 'nextStep' | 'evidence'>>,
  ): Promise<Goal | null> {
    const row = (await this.deps.goals.get(id)) as GoalRow | null
    if (!row) return null
    const next: Partial<GoalRow> = { last_touched: Date.now() }
    if (patch.title !== undefined) next.title = patch.title.slice(0, 120)
    if (patch.why !== undefined) next.why = patch.why.slice(0, 500)
    if (patch.status !== undefined) next.status = patch.status
    if (patch.nextStep !== undefined) next.next_step = patch.nextStep.slice(0, 300)
    if (patch.evidence !== undefined) next.evidence_json = JSON.stringify(patch.evidence)
    await this.deps.goals.update(id, next)
    return toGoal({ ...row, ...next } as GoalRow)
  }

  async stats(windowDays = 7): Promise<PlannerStats> {
    const since = Date.now() - windowDays * 86_400_000
    const runs = ((await this.deps.runs.find({})) as PlannerRunRow[]).filter((row) => row.at >= since)
    const created = runs.filter((row) => row.action === 'task')
    const tasks = this.deps.task()
    let tasksDone = 0
    for (const row of created) {
      if (!row.task_id || !tasks) continue
      const run = await tasks.get(row.task_id).catch(() => null)
      if (run?.status === 'done') tasksDone += 1
    }
    const requests = ((await this.deps.requests.find({})) as RequestRow[]).filter((row) => row.at >= since)
    return {
      windowDays,
      runs: runs.length,
      tasksCreated: created.length,
      tasksDone,
      reminders: runs.filter((row) => row.action === 'remind').length,
      skips: runs.filter((row) => row.action === 'skip').length,
      researchRequested: requests.length,
      researchApproved: requests.filter((row) => row.status === 'approved').length,
      researchRejected: requests.filter((row) => row.status === 'rejected').length,
      acceptance: created.length === 0 ? 0 : Math.round((tasksDone / created.length) * 100) / 100,
    }
  }

  /**
   * 一次规划：返回实际执行的动作，便于测试和审计。
   * 自动触发会受冷却/日限/深度限制；手动触发只跳过热冷却。
   */
  async replan(run: TaskRun | null, options: { trigger?: string; manual?: boolean } = {}): Promise<string> {
    const trigger = options.trigger ?? (run ? 'task-finished' : 'manual')
    const now = Date.now()
    if (!this.config.enabled) return 'disabled'
    const harness = this.deps.harness()
    if (!harness) return 'no-harness'

    if (!options.manual) {
      const last = ((await this.deps.runs.find({})) as PlannerRunRow[])
        .filter((row) => row.trigger !== 'manual')
        .sort((a, b) => b.at - a.at)[0]
      const cooldown = trigger === 'task-finished' ? this.config.taskCooldownMinutes : this.config.cooldownMinutes
      if (last && now - last.at < cooldown * 60_000) return 'cooldown'
    }

    const today = new Date(now).toDateString()
    const createdToday = ((await this.deps.runs.find({})) as PlannerRunRow[]).filter(
      (row) => row.action === 'task' && new Date(row.at).toDateString() === today,
    ).length
    const parent = run
      ? ((await this.deps.runs.find({})) as PlannerRunRow[]).find((row) => row.task_id === run.id)
      : undefined
    const depth = parent ? Number(parent.depth ?? 1) : 0
    const canCreateTask = createdToday < this.config.maxSelfTasksPerDay && depth < this.config.maxDepth

    const goals = await this.listGoals('active')
    const recent = this.deps.task() ? (await this.deps.task()!.list(this.config.historyLimit)).reverse() : []
    const prompt = buildPrompt({
      goals: goals.slice(0, this.config.goalLimit),
      recent,
      finished: run,
      canCreateTask,
      depth,
    })

    let raw = ''
    try {
      const cwd = this.config.cwd || process.cwd()
      for await (const event of harness.run({ conversationId: this.config.sessionId, text: prompt, cwd })) {
        if (event.type === 'text') raw += event.text
        else if (event.type === 'error') return this.record('error', { why: event.message })
      }
    } catch (error) {
      return this.record('error', { why: error instanceof Error ? error.message : String(error) })
    }

    const plan = parsePlan(raw)
    if (!plan) return this.record('error', { why: '模型没有返回可解析的 JSON' })

    if (plan.nextTask && canCreateTask) {
      const title = plan.nextTask.title.trim().slice(0, 80)
      const dedupeSince = now - 24 * 3_600_000
      const duplicate = ((await this.deps.runs.find({})) as PlannerRunRow[]).find(
        (row) => row.title === title && row.at >= dedupeSince,
      )
      if (!duplicate) {
        const tasks = this.deps.task()
        if (tasks) {
          const created = await tasks.create({
            prompt: plan.nextTask.prompt,
            title,
            priority: 4,
            target: { executorId: 'local' },
          })
          return this.record('task', {
            taskId: created.id,
            title,
            why: plan.nextTask.why ?? null,
            evidence: plan.nextTask.evidence ?? [],
            depth: depth + 1,
          })
        }
      }
    }

    if (plan.research && depth < this.config.maxDepth) {
      const approval = this.deps.approval()
      if (approval) {
        const minutes = Math.min(60, Math.max(3, Number(plan.research.minutes) || this.config.researchMinutes))
        const request = await approval.create({
          action: 'planner.research',
          prompt: `我想花 ${minutes} 分钟查一下「${plan.research.topic}」，批准吗？${plan.research.why ? `\n原因：${plan.research.why}` : ''}`,
          requester: 'planner',
        })
        await this.deps.requests.insert({
          approval_id: request.id,
          topic: plan.research.topic.slice(0, 120),
          why: (plan.research.why ?? '').slice(0, 300),
          minutes,
          status: 'pending',
          task_id: null,
          at: Date.now(),
        })
        return this.record('research', { title: plan.research.topic, why: plan.research.why ?? null })
      }
    }

    if (plan.reminder) {
      const channel = this.deps.channel()
      if (channel) {
        const sent = await channel
          .send({
            channel: this.config.notifyChannel,
            conversationId: this.config.notifyConversation,
            blocks: [{ type: 'text', text: plan.reminder.text }],
          })
          .catch(() => null)
        if (sent) return this.record('remind', { why: plan.reminder.why ?? null })
      }
    }

    return this.record('skip', { why: plan.skip ?? (canCreateTask ? '模型选择不做' : '达到自建上限/深度') })
  }

  private async record(
    action: string,
    detail: { taskId?: string; title?: string; why?: string | null; evidence?: string[]; depth?: number },
  ): Promise<string> {
    await this.deps.runs.insert({
      at: Date.now(),
      trigger: 'replan',
      action,
      task_id: detail.taskId ?? null,
      title: detail.title ?? null,
      why: detail.why ?? null,
      evidence_json: JSON.stringify(detail.evidence ?? []),
      depth: detail.depth ?? 0,
      status: action,
    })
    return action
  }
}

function toGoal(row: GoalRow): Goal {
  let evidence: string[] = []
  try {
    const parsed = JSON.parse(row.evidence_json || '[]')
    if (Array.isArray(parsed)) evidence = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    evidence = []
  }
  return {
    id: row.id,
    title: row.title,
    why: row.why,
    status: (row.status as Goal['status']) ?? 'active',
    nextStep: row.next_step,
    createdBy: (row.created_by as Goal['createdBy']) ?? 'user',
    evidence,
    lastTouched: new Date(row.last_touched),
    createdAt: new Date(row.created_at),
  }
}

function buildPrompt(input: {
  goals: Goal[]
  recent: TaskRun[]
  finished: TaskRun | null
  canCreateTask: boolean
  depth: number
}): string {
  const goals = input.goals.length
    ? input.goals.map((goal) => `- [${goal.id}] ${goal.title}｜下一步：${goal.nextStep || '未定'}｜${goal.why}`).join('\n')
    : '（暂无目标）'
  const recent = input.recent.length
    ? input.recent
        .map(
          (run) =>
            `- [${run.id}] ${run.status} ${run.title}${run.result ? `｜结果：${String(run.result).slice(0, 120)}` : ''}`,
        )
        .join('\n')
    : '（最近没有任务）'
  const finished = input.finished
    ? `刚结束的任务：\n- [${input.finished.id}] ${input.finished.status} ${input.finished.title}\n- 结果：${String(input.finished.result ?? input.finished.error ?? '').slice(0, 800)}`
    : '（没有刚结束的任务，这是一次定时规划）'
  return [
    '这是青梅的内部规划回合，不是和主人的聊天。只输出一个 JSON 对象，不要解释、不要 Markdown。',
    '',
    '目标（长期）：',
    goals,
    '',
    '最近任务：',
    recent,
    '',
    finished,
    '',
    `当前约束：本次${input.canCreateTask ? '可以' : '不可以'}新建任务（自建深度 ${input.depth}）。`,
    '',
    '从下面四类动作里选一个（没有价值就选 skip）：',
    '{"nextTask":{"prompt":"给执行器的一句话任务","title":"短标题","why":"为什么现在做","evidence":["run_x"]},"reminder":null,"research":null,"skip":null}',
    '{"nextTask":null,"reminder":{"text":"要对主人说的话","why":"依据"},"research":null,"skip":null}',
    '{"nextTask":null,"reminder":null,"research":{"topic":"要查的主题","why":"为什么值得查","minutes":10},"skip":null}',
    '{"nextTask":null,"reminder":null,"research":null,"skip":"为什么这次不做"}',
    '',
    '规则：',
    '- 有明确未完成事项才建 nextTask，不要为了动而动；',
    '- 提醒必须具体、可执行，不要重复最近已经说过的；',
    '- 不确定就 skip；',
    '- evidence 只能引用上面出现的任务 id 或目标 id。',
  ].join('\n')
}

export function parsePlan(raw: string): Plan | null {
  const text = raw.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    const nextTask = value.nextTask as Record<string, unknown> | null | undefined
    const reminder = value.reminder as Record<string, unknown> | null | undefined
    const research = value.research as Record<string, unknown> | null | undefined
    const skip = typeof value.skip === 'string' ? value.skip : null
    return {
      nextTask:
        nextTask && typeof nextTask.prompt === 'string' && typeof nextTask.title === 'string'
          ? {
              prompt: nextTask.prompt,
              title: nextTask.title,
              why: typeof nextTask.why === 'string' ? nextTask.why : undefined,
              evidence: Array.isArray(nextTask.evidence)
                ? nextTask.evidence.filter((item): item is string => typeof item === 'string')
                : [],
            }
          : null,
      reminder:
        reminder && typeof reminder.text === 'string'
          ? { text: reminder.text, why: typeof reminder.why === 'string' ? reminder.why : undefined }
          : null,
      research:
        research && typeof research.topic === 'string'
          ? {
              topic: research.topic,
              why: typeof research.why === 'string' ? research.why : undefined,
              minutes: Number(research.minutes) || undefined,
            }
          : null,
      skip,
    }
  } catch {
    return null
  }
}

export function apply(ctx: Context, config: PlannerConfig = {}): void {
  const store = ctx.store
  const gateway = ctx.gateway
  const goals = store.collection<GoalRow>(GOALS)
  const runs = store.collection<PlannerRunRow>(RUNS)
  const requests = store.collection<RequestRow>(REQUESTS)

  let task: TaskService | undefined
  let harness: HarnessService | undefined
  let channel: ChannelService | undefined
  let approval: ApprovalService | undefined
  ctx.inject(['task'], (sub) => { task = sub.task })
  ctx.inject(['harness'], (sub) => { harness = sub.harness })
  ctx.inject(['channel'], (sub) => { channel = sub.channel })
  ctx.inject(['approval'], (sub) => { approval = sub.approval })

  const planner = new PlannerService(
    ctx,
    {
      goals,
      runs,
      requests,
      task: () => task,
      harness: () => harness,
      channel: () => channel,
      approval: () => approval,
    },
    config,
  )
  void planner

  ctx.events.on(EVENTS.taskFinished, (run: TaskRun) => {
    if (!planner.config.enabled) return
    void planner.replan(run, { trigger: 'task-finished' }).catch(() => undefined)
  })

  ctx.events.on(EVENTS.approvalDecided, (request: ApprovalRequest) => {
    void (async () => {
      const row = ((await requests.find({})) as RequestRow[]).find((item) => item.approval_id === request.id)
      if (!row || row.status !== 'pending') return
      if (request.status === 'allowed' && planner['deps'].task()) {
        const created = await planner['deps'].task()!.create({
          prompt: `查资料：${row.topic}。最多 ${row.minutes} 分钟，给出 3 条结论和一个建议。原因：${row.why || '规划器判断值得查'}`,
          title: `资料研究：${row.topic}`.slice(0, 80),
          priority: 3,
          target: { executorId: 'local' },
        })
        await requests.update(row.id, { status: 'approved', task_id: created.id })
      } else {
        await requests.update(row.id, { status: 'rejected' })
      }
    })().catch(() => undefined)
  })

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/goals',
      async handler(_req, res) {
        res.status(200).send({ ok: true, items: await planner.listGoals() })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/goals',
      async handler(req, res) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (!title) {
          res.status(400).send({ ok: false, error: 'title 不能为空' })
          return
        }
        const goal = await planner.createGoal({
          title,
          why: typeof body.why === 'string' ? body.why : '',
          nextStep: typeof body.nextStep === 'string' ? body.nextStep : '',
          evidence: Array.isArray(body.evidence)
            ? body.evidence.filter((item): item is string => typeof item === 'string')
            : [],
        })
        res.status(200).send({ ok: true, goal })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/goals/update',
      async handler(req, res) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const goal = await planner.updateGoal(id, {
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(typeof body.why === 'string' ? { why: body.why } : {}),
          ...(typeof body.nextStep === 'string' ? { nextStep: body.nextStep } : {}),
          ...(typeof body.status === 'string' ? { status: body.status as Goal['status'] } : {}),
          ...(Array.isArray(body.evidence)
            ? { evidence: body.evidence.filter((item): item is string => typeof item === 'string') }
            : {}),
        })
        if (!goal) {
          res.status(404).send({ ok: false, error: '没有这个目标' })
          return
        }
        res.status(200).send({ ok: true, goal })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/planner/stats',
      async handler(req, res) {
        const days = Number(req.query.days ?? 7)
        res.status(200).send({ ok: true, ...(await planner.stats(Number.isFinite(days) ? days : 7)) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/planner/run',
      async handler(_req, res) {
        const action = await planner.replan(null, { trigger: 'manual', manual: true })
        res.status(200).send({ ok: true, action })
      },
    }),
  )
}







