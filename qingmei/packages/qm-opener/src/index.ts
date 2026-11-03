/**
 * @qingmei/qm-opener —— A6/A7/A8 的服务器最小闭环。
 *
 * A6 开场：只在机会窗口内、且必须有理由（承诺到期 / 任务临近截止）才开口；
 *         状态机 asked → answered | declined | ignored；每日 ≤3 条、每窗口 ≤1 条。
 * A7 承诺：从用户消息里解析「明天带饭 / 后天交」这类承诺，次日对应时间作为开场理由。
 * A8 学习：同一话题 7 天内不重复同一句；回应时间记录为偏好分钟，窗口内向它漂移；
 *         拒绝/连续忽略 2 次 → 该话题暂停 7 天。
 *
 * 内容生成是规则模板，不调用模型；理由随开场落库，可解释。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  uid,
  type ChannelService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type InboundMessage,
  type LlmService,
  type Row,
  type StoreService,
  type TaskService,
} from '@qingmei/core'

export interface OpenerConfig {
  auto?: boolean
  tickMs?: number
  clock?: () => Date
  maxDaily?: number
  pauseDays?: number
  /** 有 llm 时用模型生成开场内容；默认 true */
  useLlm?: boolean
}

export const name = 'qm-opener'
export const inject = ['store', 'channel', 'gateway']

const DAY = 24 * 60 * 60 * 1000

interface CommitmentRow extends Row {
  text: string
  due_at: number
  status: string
  source_id: string
  created_at: number
}

interface OpeningRow extends Row {
  topic: string
  text: string
  reason: string
  window: string
  status: string
  sent_at: number
  responded_at: number | null
}

interface TopicRow extends Row {
  sent: number
  answered: number
  ignored: number
  declined: number
  paused_until: number
  last_texts_json: string
  preferred_minute: number | null
}

interface Window {
  id: string
  start: number
  end: number
  weekendOnly?: boolean
}

const WINDOWS: Window[] = [
  { id: 'breakfast', start: 7 * 60 + 30, end: 9 * 60 },
  { id: 'lunch', start: 11 * 60, end: 11 * 60 + 30 },
  { id: 'afternoon', start: 14 * 60, end: 15 * 60 },
  { id: 'dinner', start: 17 * 60 + 30, end: 18 * 60 + 30 },
  { id: 'evening', start: 20 * 60 + 30, end: 21 * 60 + 30 },
  { id: 'weekend', start: 9 * 60, end: 11 * 60, weekendOnly: true },
]

const COMMITMENT_WORDS = ['带饭', '吃饭', '提醒', '交', '做', '去', '见', '买', '写', '开会']

export function apply(ctx: Context, config: OpenerConfig = {}): void {
  const store = ctx.reflect.get('store', false) as StoreService | undefined
  const channel = ctx.reflect.get('channel', false) as ChannelService | undefined
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  const llm = ctx.reflect.get('llm', false) as LlmService | undefined
  const useLlm = config.useLlm !== false
  if (!store) throw new Error('[qm-opener] 缺少 store 服务')
  if (!channel) throw new Error('[qm-opener] 缺少 channel 服务')
  if (!gateway) throw new Error('[qm-opener] 缺少 gateway 服务')
  const task = ctx.reflect.get('task', false) as TaskService | undefined

  const commitments = store.collection<CommitmentRow>('qm_commitment')
  const openings = store.collection<OpeningRow>('qm_opening')
  const topics = store.collection<TopicRow>('qm_opening_topic')
  const now = () => (config.clock ? config.clock() : new Date())
  const maxDaily = Math.max(1, config.maxDaily ?? 3)
  const pauseDays = Math.max(1, config.pauseDays ?? 7)
  let ticking = false

  async function topicOf(id: string): Promise<TopicRow> {
    const existing = await topics.get(id)
    if (existing) return existing
    return {
      id,
      sent: 0,
      answered: 0,
      ignored: 0,
      declined: 0,
      paused_until: 0,
      last_texts_json: '[]',
      preferred_minute: null,
    }
  }

  async function saveTopic(row: TopicRow): Promise<void> {
    const existing = await topics.get(row.id)
    if (existing) await topics.update(row.id, row)
    else await topics.insert(row)
  }

  async function tick(): Promise<OpeningRow[]> {
    if (ticking) return []
    ticking = true
    try {
      const at = now()
      const nowMs = at.getTime()
      const window = currentWindow(at)
      if (!window) return []

      const today = dayKey(at)
      const todays = (await openings.find({})).filter((row) => dayKey(new Date(row.sent_at)) === today)
      if (todays.length >= maxDaily) return []
      if (todays.some((row) => row.window === window.id)) return []

      const reason = await pickReason(nowMs)
      if (!reason) return []

      const topic = await topicOf(reason.topic)
      if (topic.paused_until > nowMs) return []
      const minute = at.getHours() * 60 + at.getMinutes()
      if (topic.preferred_minute !== null && minute < topic.preferred_minute) return []

      const text = await composeText(topic, reason, at)
      if (!text) return []
      const row: OpeningRow = {
        id: uid('open'),
        topic: reason.topic,
        text,
        reason: reason.reason,
        window: window.id,
        status: 'asked',
        sent_at: nowMs,
        responded_at: null,
      }
      await openings.insert(row)
      topic.sent += 1
      const history = parseTexts(topic.last_texts_json).filter((item) => nowMs - item.at < 7 * DAY)
      history.push({ text, at: nowMs })
      topic.last_texts_json = JSON.stringify(history.slice(-10))
      await saveTopic(topic)

      await channel
        .send({ channel: 'web', conversationId: 'owner', blocks: [{ type: 'text', text }] })
        .catch(() => undefined)
      return [row]
    } finally {
      ticking = false
    }
  }

  async function pickReason(nowMs: number): Promise<{ topic: string; reason: string; data: Record<string, unknown> } | null> {
    const due = (await commitments.find({}))
      .filter((row) => row.status === 'pending' && row.due_at <= nowMs + 30 * 60_000)
      .sort((a, b) => a.due_at - b.due_at)[0]
    if (due) {
      return {
        topic: 'commitment',
        reason: `承诺到期：${due.text}（${new Date(due.due_at).toLocaleString('zh-CN')}）`,
        data: { commitment: due },
      }
    }

    if (task) {
      const runs = await task.list(50)
      const soon = runs
        .filter((run) => run.status === 'queued' || run.status === 'running')
        .filter((run) => run.contract?.deadline)
        .filter((run) => run.contract!.deadline!.getTime() - nowMs <= 12 * 60 * 60_000)
        .sort((a, b) => a.contract!.deadline!.getTime() - b.contract!.deadline!.getTime())[0]
      if (soon) {
        return {
          topic: 'task',
          reason: `任务临近截止：${soon.title}（${soon.contract!.deadline!.toLocaleString('zh-CN')}）`,
          data: { run: soon },
        }
      }
    }
    return null
  }

  function pickPhrase(topic: TopicRow, reason: { topic: string; reason: string; data: Record<string, unknown> }, at: Date): string | null {
    const history = parseTexts(topic.last_texts_json)
    const phrases = phrasesFor(reason, at)
    return choosePhrase(phrases, history, at.getTime())
  }

  async function composeText(
    topic: TopicRow,
    reason: { topic: string; reason: string; data: Record<string, unknown> },
    at: Date,
  ): Promise<string | null> {
    const fallback = pickPhrase(topic, reason, at)
    if (!llm || !useLlm) return fallback
    try {
      const fact = reason.data.commitment
        ? `承诺：${String((reason.data.commitment as CommitmentRow).text)}`
        : `任务：${String((reason.data.run as { title?: string } | undefined)?.title ?? '')}`
      const { text } = await llm.complete({
        messages: [
          {
            role: 'system',
            content:
              '你是青梅。根据给出的理由写一句不超过 40 字的中文开场，只使用给定事实，不编造，不解释，不加引号。',
          },
          { role: 'user', content: `话题：${reason.topic}\n理由：${reason.reason}\n${fact}` },
        ],
      })
      const clean = text.replace(/\s+/g, ' ').replace(/^["'「」]+|["'「」]+$/g, '').trim()
      if (!clean || clean.length > 60) return fallback
      const history = parseTexts(topic.last_texts_json)
      if (history.some((item) => item.text === clean && at.getTime() - item.at < 7 * DAY)) return fallback
      return clean
    } catch {
      return fallback
    }
  }
  function phrasesFor(reason: { topic: string; reason: string; data: Record<string, unknown> }, at: Date): string[] {
    if (reason.topic === 'commitment') {
      const text = (reason.data.commitment as CommitmentRow).text
      return [
        `你之前说「${text}」，今天还按计划吗？`,
        `到点了：「${text}」。要现在做 30 分钟，还是改到明天？`,
        `「${text}」这件事，今天办还是改期？`,
      ]
    }
    const run = reason.data.run as { title: string; contract?: { deadline?: Date } } | undefined
    const hours = run?.contract?.deadline ? Math.max(0.1, (run.contract.deadline.getTime() - at.getTime()) / 3_600_000) : 12
    return [
      `「${run?.title ?? '任务'}」还有 ${hours.toFixed(1)} 小时到期，现在推进还是重排？`,
      `提醒一下：「${run?.title ?? '任务'}」今天截止。要我帮你拆成 30 分钟吗？`,
      `「${run?.title ?? '任务'}」的截止时间快到了，要不要先做一小段？`,
    ]
  }

  ctx.events.on(EVENTS.inbound, (message: InboundMessage) => {
    const text = message.blocks
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim()
    if (!text) return
    const parsed = parseCommitment(text, now())
    if (!parsed) return
    void (async () => {
      const existing = (await commitments.find({})).find((row) => row.source_id === message.platformMessageId)
      if (existing) return
      await commitments.insert({
        id: uid('promise'),
        text: parsed.text,
        due_at: parsed.dueAt.getTime(),
        status: 'pending',
        source_id: message.platformMessageId,
        created_at: now().getTime(),
      })
    })().catch(() => undefined)
  })

  const timer =
    config.auto === false ? null : setInterval(() => void tick().catch(() => undefined), config.tickMs ?? 5 * 60_000)
  timer?.unref?.()
  ctx.effect(() => () => {
    if (timer) clearInterval(timer)
  })

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/openings',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const items = (await openings.find({}))
          .sort((a, b) => b.sent_at - a.sent_at)
          .slice(0, 30)
          .map(toOpening)
        res.status(200).send({ ok: true, items })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/openings/tick',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const created = await tick()
        res.status(200).send({ ok: true, created: created.map(toOpening) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/openings/commitments',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const items = (await commitments.find({}))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 30)
          .map((row) => ({
            id: row.id,
            text: row.text,
            dueAt: new Date(row.due_at),
            status: row.status,
            createdAt: new Date(row.created_at),
          }))
        res.status(200).send({ ok: true, items })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/openings/respond',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        const response = typeof body.response === 'string' ? body.response : ''
        if (!id || !['answered', 'declined', 'ignored', 'deferred'].includes(response)) {
          res.status(400).send({ ok: false, error: 'id 必填，response 需为 answered/declined/ignored/deferred' })
          return
        }
        const row = await openings.get(id)
        if (!row || row.status !== 'asked') {
          res.status(404).send({ ok: false, error: '没有待回应的开场' })
          return
        }
        const at = now()
        await openings.update(id, { status: response, responded_at: at.getTime() })
        const topic = await topicOf(row.topic)
        if (response === 'answered') {
          topic.answered += 1
          topic.preferred_minute = at.getHours() * 60 + at.getMinutes()
        } else if (response === 'declined') {
          topic.declined += 1
          topic.paused_until = at.getTime() + pauseDays * DAY
        } else if (response === 'ignored') {
          topic.ignored += 1
          if (topic.ignored >= 2) topic.paused_until = at.getTime() + pauseDays * DAY
        }
        await saveTopic(topic)
        res.status(200).send({ ok: true, pausedUntil: topic.paused_until ? new Date(topic.paused_until) : null })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/openings/topics',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const items = (await topics.find({})).map((row) => ({
          id: row.id,
          sent: row.sent,
          answered: row.answered,
          ignored: row.ignored,
          declined: row.declined,
          pausedUntil: row.paused_until ? new Date(row.paused_until) : null,
          preferredMinute: row.preferred_minute,
        }))
        res.status(200).send({ ok: true, items })
      },
    }),
  )

  function toOpening(row: OpeningRow) {
    return {
      id: row.id,
      topic: row.topic,
      text: row.text,
      reason: row.reason,
      window: row.window,
      status: row.status,
      sentAt: new Date(row.sent_at),
      respondedAt: row.responded_at ? new Date(row.responded_at) : null,
    }
  }
}

export function choosePhrase(
  phrases: string[],
  history: { text: string; at: number }[],
  atMs: number,
): string | null {
  const used = new Set(history.filter((item) => atMs - item.at < 7 * DAY).map((item) => item.text))
  return phrases.find((phrase) => !used.has(phrase)) ?? null
}
export function parseCommitment(text: string, at: Date): { text: string; dueAt: Date } | null {
  const match = /(明天|后天)([\s\S]{0,40})/.exec(text)
  if (!match) return null
  const tail = match[2] ?? ''
  if (!COMMITMENT_WORDS.some((word) => tail.includes(word) || text.slice(0, 60).includes(word))) return null
  const dueAt = new Date(at)
  dueAt.setDate(dueAt.getDate() + (match[1] === '后天' ? 2 : 1))
  const hour = /早上|上午/.test(tail) ? 8 : /中午/.test(tail) ? 12 : /下午/.test(tail) ? 15 : /晚上/.test(tail) ? 20 : 20
  dueAt.setHours(hour, 0, 0, 0)
  return { text: match[0].trim().slice(0, 60), dueAt }
}

export function currentWindow(at: Date): Window | null {
  const minute = at.getHours() * 60 + at.getMinutes()
  const weekend = at.getDay() === 0 || at.getDay() === 6
  return (
    WINDOWS.find((window) => window.start <= minute && minute < window.end && (!window.weekendOnly || weekend)) ?? null
  )
}

function parseTexts(raw: string): { text: string; at: number }[] {
  try {
    return JSON.parse(raw) as { text: string; at: number }[]
  } catch {
    return []
  }
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export const defaultExport = { name, inject, apply }
