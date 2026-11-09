/**
 * @qingmei/qm-nudge —— W1/W2：任务合同 + L0–L2 督促阶梯（服务端最小版）。
 *
 * 每 tick 读未结束的任务，按合同算「期望进度 vs 实际进度」，落后时按阶梯给事实清单：
 *   L1 私聊提醒（事实 + 选项）→ L2 要求决策 → L3 摩擦 / L4 强制只记录，不操作设备
 *   （没有 PC/手机执行器，真正的专注模式/锁屏不在本插件范围）。
 *
 * 任何真实进展（进度/产物/启动）都会让阶梯回落并重置冷却；逃生条款按天计数。
 */
import type { Context } from 'cordis'
import {
  uid,
  type ChannelService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type Row,
  type StoreService,
  type TaskContract,
  type TaskRun,
  type TaskService,
} from '@qingmei/core'

export interface NudgeConfig {
  tickMs?: number
  /** 测试注入时钟 */
  clock?: () => Date
}

export const name = 'qm-nudge'
export const inject = ['task', 'channel', 'gateway', 'store']

const COLLECTION = 'qm_nudge_state'
const HOUR = 60 * 60 * 1000
const COOLDOWN: Record<number, number> = { 0: 3 * HOUR, 1: 3 * HOUR, 2: 6 * HOUR, 3: 12 * HOUR, 4: 24 * HOUR }

interface NudgeRow extends Row {
  level: number
  last_nudge_at: number
  last_progress_at: number
  ignored: number
  facts_json: string
  updated_at: number
  paused_until: number
  escape_day: string
  escape_used: number
}

export interface NudgeState {
  taskId: string
  title: string
  level: number
  ignored: number
  facts: string[]
  lastNudgeAt: Date | null
  lastProgressAt: Date
  pausedUntil: Date | null
}

export function expectedPercent(run: TaskRun, nowMs: number): number | null {
  const contract = run.contract
  if (!contract?.deadline) return null
  const end = contract.deadline.getTime()
  const start = run.startedAt?.getTime() ?? run.createdAt.getTime()
  if (nowMs >= end) return 100
  if (contract.expected && contract.expected.length > 0) {
    const points = [...contract.expected].sort((a, b) => a.at.getTime() - b.at.getTime())
    if (nowMs <= points[0]!.at.getTime()) return 0
    for (let i = 1; i < points.length; i += 1) {
      const left = points[i - 1]!
      const right = points[i]!
      if (nowMs > right.at.getTime()) continue
      const span = Math.max(1, right.at.getTime() - left.at.getTime())
      return left.percent + ((nowMs - left.at.getTime()) / span) * (right.percent - left.percent)
    }
    return 100
  }
  if (nowMs <= start) return 0
  return Math.min(100, ((nowMs - start) / Math.max(1, end - start)) * 100)
}

export function actualPercent(run: TaskRun): number {
  if (run.status === 'done') return 100
  if (typeof run.progress?.percent === 'number') return Math.min(100, Math.max(0, run.progress.percent))
  return 0
}

export function lastProgressAt(run: TaskRun): number {
  const times = [run.createdAt.getTime()]
  if (run.startedAt) times.push(run.startedAt.getTime())
  if (run.progress) times.push(run.progress.at.getTime())
  for (const artifact of run.artifacts) times.push(artifact.at.getTime())
  return Math.max(...times)
}

export function apply(ctx: Context, config: NudgeConfig = {}): void {
  const task = ctx.task
  const channel = ctx.channel
  const gateway = ctx.gateway
  const store = ctx.store
  if (!channel) throw new Error('[qm-nudge] 缺少 channel 服务')
  if (!gateway) throw new Error('[qm-nudge] 缺少 gateway 服务')
  if (!store) throw new Error('[qm-nudge] 缺少 store 服务')

  const states = store.collection<NudgeRow>(COLLECTION)
  const now = () => (config.clock ? config.clock() : new Date())
  let ticking = false

  async function tick(): Promise<NudgeState[]> {
    if (ticking) return []
    ticking = true
    try {
      const nowMs = now().getTime()
      const runs = await task.list(100)
      const changed: NudgeState[] = []
      for (const run of runs) {
        if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') continue
        if (!run.contract?.deadline) continue
        const expected = expectedPercent(run, nowMs)
        if (expected === null) continue

        const existing = await states.get(run.id)
        const row: NudgeRow =
          existing ?? {
            id: run.id,
            level: 0,
            last_nudge_at: 0,
            last_progress_at: lastProgressAt(run),
            ignored: 0,
            facts_json: '[]',
            updated_at: nowMs,
            paused_until: 0,
            escape_day: '',
            escape_used: 0,
          }

        if (row.paused_until > nowMs) continue
        const progressAt = lastProgressAt(run)
        // 真实进展 → 回落并重置
        if (progressAt > row.last_nudge_at && row.level > 0) {
          row.level = 0
          row.ignored = 0
          row.last_progress_at = progressAt
        }

        const actual = actualPercent(run)
        const behind = expected - actual
        if (behind <= 20) {
          row.last_progress_at = progressAt
          await save(row)
          continue
        }

        // 上一次提醒后仍无进展 → 记一次忽略
        if (row.level > 0 && progressAt <= row.last_nudge_at && nowMs - row.last_nudge_at >= COOLDOWN[row.level]!) {
          row.ignored += 1
        }

        const contract = run.contract
        const deadline = contract.deadline?.getTime()
        let target = 1
        if (behind > 40 || row.ignored >= 2) target = 2
        if (
          behind > 60 &&
          deadline !== undefined && deadline - nowMs < 8 * HOUR &&
          row.ignored >= 1 &&
          (contract.enforcement === 'strict' || contract.enforcement === 'contract')
        ) {
          target = 3
        }
        if (deadline !== undefined && nowMs > deadline && contract.enforcement === 'contract') target = 4
        // 一次只升一级，避免首个提醒直接跳到 L2
        target = Math.min(target, row.level + 1)

        if (target > row.level && nowMs - row.last_nudge_at >= COOLDOWN[row.level]!) {
          const facts = factsOf(run, expected, actual, nowMs)
          row.level = target
          row.last_nudge_at = nowMs
          row.last_progress_at = progressAt
          row.facts_json = JSON.stringify(facts)
          row.updated_at = nowMs
          await save(row)
          await notify(run, target, facts)
          changed.push(toState(run, row))
          continue
        }

        row.updated_at = nowMs
        await save(row)
      }
      return changed
    } finally {
      ticking = false
    }
  }

  async function save(row: NudgeRow): Promise<void> {
    const existing = await states.get(row.id)
    if (existing) await states.update(row.id, row)
    else await states.insert(row)
  }

  async function notify(run: TaskRun, level: number, facts: string[]): Promise<void> {
    const head = level >= 4 ? '⛔ 已逾期' : level >= 3 ? '🚧 需要处理' : level >= 2 ? '⚠️ 还没有进展' : '⏰ 进度落后'
    const options =
      level >= 2 ? '请选一个：重排期 / 降范围 / 现在做 30 分钟。' : '选项：现在做 30 分钟 / 重排期 / 降范围。'
    const note = level >= 3 ? '（已改为气泡提醒，不会操作你的设备）' : ''
    const text = `${head}：「${run.title}」\n${facts.map((fact) => `- ${fact}`).join('\n')}\n${options}${note}`
    await channel
      .send({ channel: 'web', conversationId: 'owner', blocks: [{ type: 'text', text }] })
      .catch(() => undefined)
  }

  function factsOf(run: TaskRun, expected: number, actual: number, nowMs: number): string[] {
    const contract = run.contract as TaskContract
    const left = Math.max(0, contract.deadline!.getTime() - nowMs)
    return [
      `期望 ${Math.round(expected)}%，实际 ${Math.round(actual)}%，落后 ${Math.round(expected - actual)} 个百分点`,
      `距截止 ${(left / HOUR).toFixed(1)} 小时`,
      run.progress ? `最近进展：${run.progress.phase}` : '还没有进展记录',
      `授权强度：${contract.enforcement}`,
    ]
  }

  function toState(run: TaskRun, row: NudgeRow): NudgeState {
    return {
      taskId: run.id,
      title: run.title,
      level: row.level,
      ignored: row.ignored,
      facts: JSON.parse(row.facts_json) as string[],
      lastNudgeAt: row.last_nudge_at ? new Date(row.last_nudge_at) : null,
      lastProgressAt: new Date(row.last_progress_at),
      pausedUntil: row.paused_until ? new Date(row.paused_until) : null,
    }
  }

  const timer = config.tickMs === 0 ? null : setInterval(() => void tick().catch(() => undefined), config.tickMs ?? 5 * 60_000)
  timer?.unref?.()
  ctx.effect(() => () => {
    if (timer) clearInterval(timer)
  })

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/nudge',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const rows = await states.find({})
        const items = []
        for (const row of rows) {
          const run = await task.get(row.id)
          if (!run) continue
          items.push(toState(run, row))
        }
        res.status(200).send({ ok: true, items, executor: 'none' })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/nudge/tick',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const changed = await tick()
        res.status(200).send({ ok: true, changed })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/nudge/pause',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : ''
        const hours = Math.min(24, Math.max(1, Number(body.hours ?? 2)))
        if (!taskId) {
          res.status(400).send({ ok: false, error: 'taskId 必填' })
          return
        }
        const run = await task.get(taskId)
        if (!run) {
          res.status(404).send({ ok: false, error: '没有这个任务' })
          return
        }
        const day = now().toISOString().slice(0, 10)
        const existing = await states.get(taskId)
        const row: NudgeRow =
          existing ?? {
            id: taskId,
            level: 0,
            last_nudge_at: 0,
            last_progress_at: lastProgressAt(run),
            ignored: 0,
            facts_json: '[]',
            updated_at: now().getTime(),
            paused_until: 0,
            escape_day: day,
            escape_used: 0,
          }
        if (row.escape_day !== day) {
          row.escape_day = day
          row.escape_used = 0
        }
        const perDay = run.contract?.escape?.perDay ?? 1
        if (row.escape_used >= perDay) {
          res.status(429).send({ ok: false, error: '今天的逃生次数用完了' })
          return
        }
        row.escape_used += 1
        row.paused_until = now().getTime() + hours * HOUR
        await save(row)
        res.status(200).send({ ok: true, pausedUntil: new Date(row.paused_until) })
      },
    }),
  )

}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export const defaultExport = { name, inject, apply }
