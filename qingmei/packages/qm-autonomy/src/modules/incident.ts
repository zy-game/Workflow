/**
 * @qingmei/qm-incident —— S1 自愈的最小闭环（docs/05 S1）。
 *
 * 回合失败 / 任务失败 → 生成 incident：
 *   - 指纹去重：同一故障 24h 内只累加次数，不重复建行
 *   - 提案：给 owner 推一条结构化报告（现象/上下文/建议）
 *   - 熔断：同一天提案超过 3 次或连续失败 2 次 → 不再打扰，转人工
 *   - 派诊断：owner 确认后把 incident 派成 harness 任务（不自动改代码/配置）
 *
 * 原子换版与自动回滚依赖 supervisor，不在本插件范围内。
 */
import { createHash } from 'node:crypto'
import type { Context } from 'cordis'
import {
  EVENTS,
  uid,
  type ChannelService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type Row,
  type StoreService,
  type TaskRun,
  type TaskRunnerService,
  type TaskService,
  type TurnEnd,
} from '@qingmei/core'

export interface IncidentConfig {
  /** 同一故障 24h 内合并 */
  windowMs?: number
  /** 每天最多推几条提案 */
  maxProposalsPerDay?: number
  /** 连续失败多少次熔断到人工 */
  fuseAfterFailures?: number
  /** 命中 playbook 时自动派诊断任务（默认开） */
  autoFix?: boolean
  /** playbook 被拒多少次后停用 */
  playbookDisableAfter?: number
}

export const name = 'qm-incident'
export const inject = ['store', 'channel', 'gateway']

const COLLECTION = 'qm_incident'
const PLAYBOOK_COLLECTION = 'qm_incident_playbook'

interface PlaybookRow extends Row {
  fingerprint: string
  root_cause: string
  action: string
  successes: number
  failures: number
  disabled: boolean
  counterexamples_json: string
  created_at: number
  last_used_at: number | null
}

interface IncidentRow extends Row {
  fingerprint: string
  kind: string
  message: string
  context_json: string
  run_id?: string | null
  task_id?: string | null
  count: number
  day: string
  proposals_today: number
  first_at: number
  last_at: number
  status: string
}

export interface Incident {
  id: string
  fingerprint: string
  kind: string
  message: string
  context: Record<string, unknown>
  runId?: string | null
  /** 失败任务 id（故障挂在任务上） */
  taskId?: string | null
  count: number
  proposalsToday: number
  firstAt: Date
  lastAt: Date
  status: 'open' | 'proposed' | 'acknowledged' | 'fused' | 'resolved'
}

export function apply(ctx: Context, config: IncidentConfig = {}): void {
  const store = ctx.store
  const channel = ctx.channel
  const gateway = ctx.gateway
  if (!channel) throw new Error('[qm-incident] 缺少 channel 服务')
  if (!gateway) throw new Error('[qm-incident] 缺少 gateway 服务')

  let task: TaskService | undefined
  let taskRunner: TaskRunnerService | undefined
  ctx.inject(['task'], (sub) => { task = sub.task })
  ctx.inject(['taskRunner'], (sub) => { taskRunner = sub.taskRunner })
  const incidents = store.collection<IncidentRow>(COLLECTION)
  const playbooks = store.collection<PlaybookRow>(PLAYBOOK_COLLECTION)
  const windowMs = config.windowMs ?? 24 * 60 * 60 * 1000
  const maxProposals = Math.max(1, config.maxProposalsPerDay ?? 3)
  const fuseAfter = Math.max(1, config.fuseAfterFailures ?? 2)
  const autoFix = config.autoFix !== false
  const disableAfter = Math.max(1, config.playbookDisableAfter ?? 3)
  let queue: Promise<unknown> = Promise.resolve()

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function record(kind: string, message: string, context: Record<string, unknown>): Promise<Incident> {
    const fingerprint = fingerprintOf(kind, message)
    return serialize(async () => {
      const now = Date.now()
      const rows = await incidents.find({})
      const existing = rows
        .filter((row) => row.fingerprint === fingerprint)
        .sort((a, b) => b.last_at - a.last_at)[0]
      const day = dayKey(new Date(now))

      // resolved 之后再犯，视为新一次故障：走 playbook 命中路径，而不是并进旧行
      if (existing && existing.status !== 'resolved' && now - existing.last_at <= windowMs) {
        const count = existing.count + 1
        const proposalsToday = existing.day === day ? existing.proposals_today : 0
        const fused = existing.status === 'fused' || count >= fuseAfter
        const status = fused ? 'fused' : existing.status
        await incidents.update(existing.id, {
          count,
          last_at: now,
          status,
          day,
          proposals_today: proposalsToday,
          message,
          context_json: JSON.stringify(context),
        })
        if (fused && existing.status !== 'fused') {
          await channel
            .send({
              channel: 'web',
              conversationId: 'owner',
              blocks: [{ type: 'text', text: `🔒 同一故障（${fingerprint}）连续失败，已熔断到人工处理。` }],
            })
            .catch(() => undefined)
        }
        const row = await incidents.get(existing.id)
        return toIncident(row!)
      }

      const todayProposals = rows
        .filter((row) => row.day === day)
        .reduce((sum, row) => sum + row.proposals_today, 0)
      const canPropose = todayProposals < maxProposals

      // 命中 playbook：有已知根因/动作时，低风险路径是“自动派诊断任务”，不直接改代码
      const playbookRows = await playbooks.find({})
      const playbook = playbookRows.find((item) => item.fingerprint === fingerprint && !item.disabled)
      let status = canPropose ? 'proposed' : 'fused'
      let runId: string | null = null
      if (playbook && autoFix && canPropose && task && taskRunner) {
        try {
          const run = await task.create({
            prompt: playbookPrompt(playbook, message, context),
            title: `自愈：${fingerprint}`,
            priority: 6,
          })
          taskRunner.dispatch(run)
          runId = run.id
          status = 'acknowledged'
          await playbooks.update(playbook.id, { last_used_at: now })
        } catch {
          status = canPropose ? 'proposed' : 'fused'
        }
      }

      const inserted = await incidents.insert({
        id: uid('inc'),
        fingerprint,
        kind,
        message,
        context_json: JSON.stringify(context),
        run_id: runId,
        task_id: kind === 'task' ? (typeof context.runId === 'string' ? context.runId : null) : null,
        count: 1,
        day,
        proposals_today: canPropose && runId === null ? 1 : 0,
        first_at: now,
        last_at: now,
        status,
      })

      if (runId) {
        // docs/05 S2：命中 playbook 的自动修复不弹窗，只在 incident 账本里留痕
      } else if (canPropose) {
        const suggestion = playbook
          ? `\n已有 playbook：${playbook.root_cause.slice(0, 100)} → ${playbook.action.slice(0, 100)}（未自动执行）`
          : ''
        await channel
          .send({
            channel: 'web',
            conversationId: 'owner',
            blocks: [
              {
                type: 'text',
                text: `🩺 检测到故障（${fingerprint}）：${message.slice(0, 160)}\n已记录为 ${inserted.id}；可在后台派诊断任务。${suggestion}`,
              },
            ],
          })
          .catch(() => undefined)
      }
      return toIncident(inserted)
    })
  }

  ctx.events.on(EVENTS.turnEnd, (end: TurnEnd) => {
    if (end.ok) return
    void record('turn', end.error ?? '回合失败', {
      sessionId: end.sessionId,
      traceId: end.traceId,
      userText: end.userText?.slice(0, 200),
    }).catch(() => undefined)
  })

  ctx.events.on(EVENTS.taskFinished, (run: TaskRun) => {
    if (run.status !== 'failed') return
    void record('task', run.error ?? '任务失败', {
      runId: run.id,
      title: run.title,
      project: run.project,
    }).catch(() => undefined)
  })

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/incidents',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const status = typeof req.query.status === 'string' ? req.query.status : ''
        const rows = (await incidents.find({}))
          .filter((row) => !status || row.status === status)
          .sort((a, b) => b.last_at - a.last_at)
        res.status(200).send({ ok: true, items: rows.map(toIncident) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/incidents/dispatch',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        if (!task || !taskRunner) {
          res.status(503).send({ ok: false, error: '没有可用的任务执行器' })
          return
        }
        const row = await incidents.get(id)
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这个 incident' })
          return
        }
        const context = parseJson<Record<string, unknown>>(row.context_json, {})
        const run = await task.create({
          prompt: [
            '自愈诊断任务：请定位下面这个故障的原因并给出修复方案。',
            '能安全修复就直接修并验证；不能就给出结论、风险与建议，不要改生产服务配置。',
            '',
            `故障指纹：${row.fingerprint}`,
            `现象：${row.message}`,
            `上下文：${JSON.stringify(context).slice(0, 800)}`,
          ].join('\n'),
          title: `自愈诊断：${row.fingerprint}`,
          priority: 6,
        })
        taskRunner.dispatch(run)
        await incidents.update(id, { status: 'acknowledged' })
        res.status(202).send({ ok: true, runId: run.id })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/incidents/resolve',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const row = await incidents.get(id)
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这个 incident' })
          return
        }
        const rootCause = typeof body.rootCause === 'string' ? body.rootCause.trim() : ''
        const action = typeof body.action === 'string' ? body.action.trim() : ''
        await incidents.update(id, { status: 'resolved' })

        let playbookId: string | null = null
        if (rootCause && action) {
          const rows = await playbooks.find({})
          const existing = rows.find((item) => item.fingerprint === row.fingerprint)
          if (existing) {
            await playbooks.update(existing.id, {
              root_cause: rootCause,
              action,
              successes: existing.successes + 1,
            })
            playbookId = existing.id
          } else {
            const inserted = await playbooks.insert({
              id: uid('pb'),
              fingerprint: row.fingerprint,
              root_cause: rootCause,
              action,
              successes: 1,
              failures: 0,
              disabled: false,
              counterexamples_json: '[]',
              created_at: Date.now(),
              last_used_at: null,
            })
            playbookId = inserted.id
          }
        }
        res.status(200).send({ ok: true, ...(playbookId ? { playbookId } : {}) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/incidents/reject',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const row = await incidents.get(id)
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这个 incident' })
          return
        }

        let disabled = false
        const rows = await playbooks.find({})
        const playbook = rows.find((item) => item.fingerprint === row.fingerprint)
        if (playbook) {
          const failures = playbook.failures + 1
          disabled = failures >= disableAfter
          const counterexamples = parseJson<string[]>(playbook.counterexamples_json, [])
          if (typeof body.note === 'string' && body.note.trim()) {
            counterexamples.push(body.note.trim().slice(0, 200))
          }
          await playbooks.update(playbook.id, {
            failures,
            disabled,
            counterexamples_json: JSON.stringify(counterexamples.slice(-10)),
          })
          if (disabled) {
            await channel
              .send({
                channel: 'web',
                conversationId: 'owner',
                blocks: [
                  {
                    type: 'text',
                    text: `⛔ playbook（${row.fingerprint}）被拒 ${failures} 次，已停用；后续只做只读建议。`,
                  },
                ],
              })
              .catch(() => undefined)
          }
        }
        await incidents.update(id, { status: 'fused' })
        res.status(200).send({ ok: true, playbookDisabled: disabled })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/incidents/rollback',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const row = await incidents.get(id)
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这个 incident' })
          return
        }
        if (!row.run_id) {
          res.status(400).send({ ok: false, error: '这个 incident 没有可回滚的自动任务' })
          return
        }
        const cancelled = taskRunner ? await taskRunner.cancel(row.run_id, '被主人回滚自愈任务') : false
        await incidents.update(id, { status: 'resolved' })
        await channel
          .send({
            channel: 'web',
            conversationId: 'owner',
            blocks: [
              {
                type: 'text',
                text: `↩️ 已回滚自愈任务 ${row.run_id}${cancelled ? '' : '（任务可能已结束，仅记录回滚）'}`,
              },
            ],
          })
          .catch(() => undefined)
        res.status(200).send({ ok: true, cancelled })
      },
    }),
  )
}

function playbookPrompt(playbook: PlaybookRow, message: string, context: Record<string, unknown>): string {
  return [
    '自愈诊断任务（命中历史 playbook）：请先确认根因是否仍成立，再按已知动作修复并验证。',
    '不要把未经确认的改动推到生产；无法安全修复就给出结论与风险。',
    '',
    `故障指纹：${playbook.fingerprint}`,
    `现象：${message}`,
    `已知根因：${playbook.root_cause}`,
    `上次修复动作：${playbook.action}`,
    `上下文：${JSON.stringify(context).slice(0, 800)}`,
  ].join('\n')
}

export function fingerprintOf(kind: string, message: string): string {
  const normalized = `${kind}:${message.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)}`
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12)
}

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    kind: row.kind,
    message: row.message,
    context: parseJson<Record<string, unknown>>(row.context_json, {}),
    runId: row.run_id ?? null,
    taskId: row.task_id ?? null,
    count: row.count,
    proposalsToday: row.proposals_today,
    firstAt: new Date(row.first_at),
    lastAt: new Date(row.last_at),
    status: ['open', 'proposed', 'acknowledged', 'fused', 'resolved'].includes(row.status)
      ? (row.status as Incident['status'])
      : 'open',
  }
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export const defaultExport = { name, inject, apply }

