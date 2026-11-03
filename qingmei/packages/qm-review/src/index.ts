/**
 * @qingmei/qm-review —— R 周期复盘（docs/05 §R 的最小版）。
 *
 * 每月 1 号生成一份报告：对话/任务/故障/主动性的月度计数与失败 Top，发到 owner 私聊，
 * 落 `qm_review`。`POST /api/v1/review/score` 记录主人打分；低于阈值时给一条改进建议。
 *
 * 只读其它 `qm_*` 账本（qm_turn / qm_task_run / qm_incident），不反向写它们。
 */
import type { Context } from 'cordis'
import {
  uid,
  type AutonomyService,
  type ChannelService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type Row,
  type StoreService,
} from '@qingmei/core'

export interface ReviewConfig {
  /** 每月几号跑，默认 1 */
  dayOfMonth?: number
  /** 几点跑，默认 9 */
  hour?: number
  /** 低于这个分数提醒改进 */
  minScore?: number
}

export const name = 'qm-review'
export const inject = ['store', 'channel', 'gateway']

const REVIEW_COLLECTION = 'qm_review'

interface ProposalRow extends Row {
  review_id: string
  month: string
  suggestion: string
  status: string
  created_at: number
}

interface ReviewRow extends Row {
  month: string
  at: number
  markdown: string
  metrics_json: string
  score: number | null
  note: string | null
}

interface TurnRow extends Row {
  status: string
  latency_ms: number | null
  error_code?: string | null
  created_at: number
}

interface TaskRow extends Row {
  status: string
  created_at: number
}

interface IncidentRow extends Row {
  status: string
  message: string
  created_at?: number
  first_at?: number
}

export interface ReviewMetrics {
  month: string
  turns: { total: number; ok: number; failed: number; avgLatencyMs: number }
  tasks: { total: number; done: number; failed: number }
  incidents: { total: number; open: number; fused: number }
  autonomy: { accepted: number; ignored: number; complaints: number } | null
  topErrors: { reason: string; count: number }[]
  /** 最近 12 条消息抽样（给评分卡/复盘看） */
  samples: { role: string; text: string }[]
}

export function apply(ctx: Context, config: ReviewConfig = {}): void {
  const store = ctx.reflect.get('store', false) as StoreService | undefined
  const channel = ctx.reflect.get('channel', false) as ChannelService | undefined
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!store) throw new Error('[qm-review] 缺少 store 服务')
  if (!channel) throw new Error('[qm-review] 缺少 channel 服务')
  if (!gateway) throw new Error('[qm-review] 缺少 gateway 服务')

  const reviews = store.collection<ReviewRow>(REVIEW_COLLECTION)
  const proposals = store.collection<ProposalRow>('qm_review_proposal')
  const turns = store.collection<TurnRow>('qm_turn')
  const messages = store.collection<{ id: string; role: string; text: string; created_at: number }>('qm_message')
  const tasks = store.collection<TaskRow>('qm_task_run')
  const incidents = store.collection<IncidentRow>('qm_incident')
  const dayOfMonth = Math.min(28, Math.max(1, Math.round(Number(config.dayOfMonth ?? 1))))
  const hour = Math.min(23, Math.max(0, Math.round(Number(config.hour ?? 9))))
  const minScore = Math.min(10, Math.max(1, Math.round(Number(config.minScore ?? 6))))

  async function metricsFor(month: string): Promise<ReviewMetrics> {
    const start = new Date(`${month}-01T00:00:00`).getTime()
    const end = new Date(start)
    end.setMonth(end.getMonth() + 1)
    const inMonth = (at: number | undefined): boolean =>
      typeof at === 'number' && at >= start && at < end.getTime()

    const turnRows = (await turns.find({})).filter((row) => inMonth(row.created_at))
    const taskRows = (await tasks.find({})).filter((row) => inMonth(row.created_at))
    const incidentRows = (await incidents.find({})).filter((row) => inMonth(row.first_at ?? row.created_at))
    const autonomy = ctx.reflect.get('autonomy', false) as AutonomyService | undefined
    const state = autonomy ? await autonomy.status().catch(() => null) : null

    const errors = new Map<string, number>()
    for (const row of turnRows) {
      if (row.status === 'ok') continue
      const reason = (row.error_code ?? '未知错误').slice(0, 80)
      errors.set(reason, (errors.get(reason) ?? 0) + 1)
    }
    const topErrors = [...errors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => ({ reason, count }))

    const sampleRows = (await messages.find({}))
      .filter((row) => inMonth(row.created_at))
      .sort((a, b) => a.created_at - b.created_at)
      .slice(-12)
      .map((row) => ({ role: row.role, text: String(row.text).slice(0, 200) }))

    const latencies = turnRows.map((row) => row.latency_ms).filter((value): value is number => typeof value === 'number')
    return {
      month,
      turns: {
        total: turnRows.length,
        ok: turnRows.filter((row) => row.status === 'ok').length,
        failed: turnRows.filter((row) => row.status !== 'ok').length,
        avgLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
      },
      tasks: {
        total: taskRows.length,
        done: taskRows.filter((row) => row.status === 'done').length,
        failed: taskRows.filter((row) => row.status === 'failed').length,
      },
      incidents: {
        total: incidentRows.length,
        open: incidentRows.filter((row) => row.status === 'open' || row.status === 'proposed').length,
        fused: incidentRows.filter((row) => row.status === 'fused').length,
      },
      autonomy: state
        ? { accepted: state.accepted, ignored: state.ignored, complaints: state.complaints ?? 0 }
        : null,
      topErrors,
      samples: sampleRows,
    }
  }

  function renderReport(metrics: ReviewMetrics): string {
    const lines = [
      `# 青梅月度复盘 · ${metrics.month}`,
      '',
      `- 对话：${metrics.turns.total} 回合（成功 ${metrics.turns.ok}，失败 ${metrics.turns.failed}，平均 ${metrics.turns.avgLatencyMs} ms）`,
      `- 任务：${metrics.tasks.total} 个（完成 ${metrics.tasks.done}，失败 ${metrics.tasks.failed}）`,
      `- 故障：新增 ${metrics.incidents.total}（待处理 ${metrics.incidents.open}，熔断 ${metrics.incidents.fused}）`,
    ]
    if (metrics.autonomy) {
      lines.push(
        `- 主动性：采纳 ${metrics.autonomy.accepted}，忽略 ${metrics.autonomy.ignored}，投诉 ${metrics.autonomy.complaints}`,
      )
    }
    if (metrics.samples.length > 0) {
      lines.push('', '## 抽样')
      for (const sample of metrics.samples.slice(-6)) {
        lines.push(`- ${sample.role === 'user' ? '你' : '青梅'}：${sample.text}`)
      }
    }
    if (metrics.topErrors.length > 0) {
      lines.push('', '## 需要关注')
      for (const item of metrics.topErrors) lines.push(`- ${item.reason}（${item.count} 次）`)
    } else {
      lines.push('', '## 需要关注', '- 本月没有失败回合')
    }
    return lines.join('\n')
  }

  async function generate(force = false): Promise<ReviewRow> {
    const now = new Date()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const existing = (await reviews.find({})).find((row) => row.month === month)
    if (existing && !force) return existing

    const metrics = await metricsFor(month)
    const markdown = renderReport(metrics)
    const row: ReviewRow = {
      id: existing?.id ?? uid('review'),
      month,
      at: Date.now(),
      markdown,
      metrics_json: JSON.stringify(metrics),
      score: existing?.score ?? null,
      note: existing?.note ?? null,
    }
    if (existing) await reviews.update(existing.id, row)
    else await reviews.insert(row)

    await channel
      .send({
        channel: 'web',
        conversationId: 'owner',
        blocks: [{ type: 'text', text: markdown }],
      })
      .catch(() => undefined)
    return row
  }

  function schedule(): ReturnType<typeof setTimeout> {
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), dayOfMonth, hour, 0, 0, 0)
    if (next.getTime() <= now.getTime()) next.setMonth(next.getMonth() + 1)
    const timer = setTimeout(() => {
      void generate()
        .catch(() => undefined)
        .finally(() => {
          const replaced = schedule()
          current = replaced
        })
    }, next.getTime() - now.getTime())
    timer.unref?.()
    return timer
  }
  let current = schedule()
  ctx.effect(() => () => clearTimeout(current))

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/review/run',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const row = await generate(true)
        res.status(200).send({ ok: true, review: toReview(row) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/review',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const rows = (await reviews.find({})).map(toReview).sort((a, b) => b.month.localeCompare(a.month))
        res.status(200).send({ ok: true, items: rows })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/review/score',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        const score = Number(body.score)
        if (!id || !Number.isFinite(score) || score < 1 || score > 10) {
          res.status(400).send({ ok: false, error: 'id 必填，score 需在 1..10' })
          return
        }
        const row = await reviews.get(id)
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这份复盘' })
          return
        }
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null
        await reviews.update(id, { score: Math.round(score), note })
        if (score < minScore) {
          await proposals.insert({
            id: uid('prop'),
            review_id: id,
            month: row.month,
            suggestion: `本月自评 ${Math.round(score)}/10，低于 ${minScore}。建议：从报告里挑一件最影响体验的事，下月只改它；必要时调整人格/提示词。`,
            status: 'proposed',
            created_at: Date.now(),
          })
          await channel
            .send({
              channel: 'web',
              conversationId: 'owner',
              blocks: [
                {
                  type: 'text',
                  text: `📉 本月自评 ${score}/10（低于 ${minScore}）。建议从报告里挑一件最影响体验的事，下月只改它。`,
                },
              ],
            })
            .catch(() => undefined)
        }
        res.status(200).send({ ok: true })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/review/proposals',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const items = (await proposals.find({}))
          .filter((row) => row.status === 'proposed')
          .sort((a, b) => b.created_at - a.created_at)
          .map((row) => ({
            id: row.id,
            reviewId: row.review_id,
            month: row.month,
            suggestion: row.suggestion,
            createdAt: new Date(row.created_at),
          }))
        res.status(200).send({ ok: true, items })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/review/proposals/dismiss',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const row = await proposals.get(id)
        if (!row || row.status !== 'proposed') {
          res.status(404).send({ ok: false, error: '没有这条提案' })
          return
        }
        await proposals.update(id, { status: 'dismissed' })
        res.status(200).send({ ok: true })
      },
    }),
  )

  function toReview(row: ReviewRow) {
    return {
      id: row.id,
      month: row.month,
      at: new Date(row.at),
      markdown: row.markdown,
      metrics: JSON.parse(row.metrics_json) as ReviewMetrics,
      score: row.score,
      note: row.note,
    }
  }
}

export const defaultExport = { name, inject, apply }
