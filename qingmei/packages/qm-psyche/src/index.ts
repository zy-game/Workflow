/**
 * 心灵状态：心情、关系、日记。
 *
 * 这些不是任务，也不是记忆事实；它们决定“她现在是什么状态、和你熟到什么程度”。
 * 心情按半衰期回落到平静，关系随互动累积，日记由 owner 会话每天写一次。
 */
import { Service, type Context } from 'cordis'
import { EVENTS, uid, type Collection, type GatewayRequest, type GatewayResponse, type Row, type TaskRun } from '@qingmei/core'

export const name = 'qm-psyche'
export const inject = ['store', 'gateway']

export interface Mood {
  valence: number
  arousal: number
  label: string
  reason: string
  updatedAt: Date
}

export interface Relation {
  stage: 'new' | 'familiar' | 'trusted'
  trust: number
  rituals: string[]
  sharedEvents: Array<{ at: Date; text: string }>
  boundaries: string[]
  updatedAt: Date
}

export interface Journal {
  day: string
  text: string
  at: Date
}

export interface DailyNote {
  day: string
  kind: 'plan' | 'review'
  text: string
  at: Date
}

export interface PsycheConfig {
  /** 心情回落到平静的半衰期（小时） */
  moodHalfLifeHours?: number
  /** 关系升级阈值 */
  familiarAt?: number
  trustedAt?: number
}

interface MoodRow extends Row {
  valence: number
  arousal: number
  label: string
  reason: string
  updated_at: number
}

interface RelationRow extends Row {
  stage: string
  trust: number
  rituals_json: string
  shared_events_json: string
  boundaries_json: string
  updated_at: number
}

interface JournalRow extends Row {
  day: string
  text: string
  at: number
}

interface NoteRow extends Row {
  day: string
  kind: string
  text: string
  at: number
}

const POSITIVE = ['谢谢', '喜欢', '棒', '厉害', '开心', '爱你', '辛苦了', '靠谱', '不错', '好耶']
const NEGATIVE = ['烦', '讨厌', '生气', '失望', '垃圾', '笨', '傻', '滚', '无语', '糟糕']

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function moodLabel(valence: number, arousal: number): string {
  if (valence >= 0.45 && arousal >= 0.55) return '兴奋'
  if (valence >= 0.2) return '开心'
  if (valence <= -0.4) return '低落'
  if (valence <= -0.15) return '烦躁'
  return '平静'
}

function parseArray<T>(raw: string | undefined, fallback: T[]): T[] {
  try {
    const parsed = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? (parsed as T[]) : fallback
  } catch {
    return fallback
  }
}

class PsycheService extends Service {
  private readonly moods: Collection<MoodRow>
  private readonly relations: Collection<RelationRow>
  private readonly journalRows: Collection<JournalRow>
  private readonly noteRows: Collection<NoteRow>
  private readonly config: Required<PsycheConfig>
  memory: { ingest: (records: unknown[]) => Promise<unknown> } | undefined

  constructor(
    ctx: Context,
    collections: {
      moods: Collection<MoodRow>
      relations: Collection<RelationRow>
      journals: Collection<JournalRow>
      notes: Collection<NoteRow>
    },
    config: PsycheConfig,
  ) {
    super(ctx, 'psyche')
    this.moods = collections.moods
    this.relations = collections.relations
    this.journalRows = collections.journals
    this.noteRows = collections.notes
    this.config = {
      moodHalfLifeHours: config.moodHalfLifeHours ?? 6,
      familiarAt: config.familiarAt ?? 20,
      trustedAt: config.trustedAt ?? 60,
    }
  }

  async mood(now = new Date()): Promise<Mood> {
    const row = await this.moods.get('owner')
    if (!row) {
      return { valence: 0, arousal: 0.3, label: '平静', reason: '', updatedAt: now }
    }
    const hours = Math.max(0, (now.getTime() - row.updated_at) / 3_600_000)
    const decay = Math.pow(0.5, hours / this.config.moodHalfLifeHours)
    const valence = Number((row.valence * decay).toFixed(3))
    const arousal = Number((0.3 + (row.arousal - 0.3) * decay).toFixed(3))
    return {
      valence,
      arousal,
      label: moodLabel(valence, arousal),
      reason: row.reason,
      updatedAt: new Date(row.updated_at),
    }
  }

  async touchMood(delta: { valence?: number; arousal?: number; reason?: string }, now = new Date()): Promise<Mood> {
    const current = await this.mood(now)
    const valence = clamp(current.valence + (delta.valence ?? 0), -1, 1)
    const arousal = clamp(current.arousal + (delta.arousal ?? 0), 0, 1)
    const row: Omit<MoodRow, 'id'> = {
      valence,
      arousal,
      label: moodLabel(valence, arousal),
      reason: (delta.reason ?? '').slice(0, 200),
      updated_at: now.getTime(),
    }
    const existing = await this.moods.get('owner')
    if (existing) await this.moods.update('owner', row)
    else await this.moods.insert({ id: 'owner', ...row })
    return { valence, arousal, label: row.label, reason: row.reason, updatedAt: now }
  }

  async relation(): Promise<Relation> {
    const row = await this.relations.get('owner')
    if (!row) {
      return {
        stage: 'new',
        trust: 0,
        rituals: [],
        sharedEvents: [],
        boundaries: [],
        updatedAt: new Date(),
      }
    }
    const trust = clamp(Math.round(row.trust), 0, 100)
    return {
      stage: trust >= this.config.trustedAt ? 'trusted' : trust >= this.config.familiarAt ? 'familiar' : 'new',
      trust,
      rituals: parseArray<string>(row.rituals_json, []),
      sharedEvents: parseArray<{ at: string; text: string }>(row.shared_events_json, []).map((event) => ({
        at: new Date(event.at),
        text: event.text,
      })),
      boundaries: parseArray<string>(row.boundaries_json, []),
      updatedAt: new Date(row.updated_at),
    }
  }

  private async saveRelation(patch: Partial<{ trust: number; rituals: string[]; sharedEvents: Relation['sharedEvents']; boundaries: string[] }>, now = new Date()): Promise<Relation> {
    const current = await this.relation()
    const trust = clamp(Math.round(patch.trust ?? current.trust), 0, 100)
    const row: Omit<RelationRow, 'id'> = {
      stage: trust >= this.config.trustedAt ? 'trusted' : trust >= this.config.familiarAt ? 'familiar' : 'new',
      trust,
      rituals_json: JSON.stringify(patch.rituals ?? current.rituals),
      shared_events_json: JSON.stringify((patch.sharedEvents ?? current.sharedEvents).slice(-30)),
      boundaries_json: JSON.stringify(patch.boundaries ?? current.boundaries),
      updated_at: now.getTime(),
    }
    const existing = await this.relations.get('owner')
    if (existing) await this.relations.update('owner', row)
    else await this.relations.insert({ id: 'owner', ...row })
    return this.relation()
  }

  /** 每条用户消息：情绪微调 + 关系信任 +1 */
  async onUserMessage(text: string, now = new Date()): Promise<void> {
    const value = String(text ?? '')
    const positive = POSITIVE.some((word) => value.includes(word))
    const negative = NEGATIVE.some((word) => value.includes(word))
    const delta = positive && !negative ? 0.12 : negative && !positive ? -0.15 : 0
    if (delta !== 0) {
      await this.touchMood({ valence: delta, arousal: delta > 0 ? 0.05 : 0.08, reason: value.slice(0, 60) }, now)
    }
    await this.saveRelation({ trust: (await this.relation()).trust + 1 }, now)
  }

  /** 任务结束：完成算共同经历，失败让心情略降 */
  async onTaskFinished(run: TaskRun, now = new Date()): Promise<void> {
    if (run.status === 'done') {
      const relation = await this.relation()
      await this.saveRelation(
        {
          trust: relation.trust + 2,
          sharedEvents: [...relation.sharedEvents, { at: now, text: `一起完成：${run.title}` }],
        },
        now,
      )
      await this.touchMood({ valence: 0.05, reason: `完成 ${run.title}` }, now)
    } else if (run.status === 'failed') {
      await this.touchMood({ valence: -0.08, reason: `失败 ${run.title}` }, now)
    }
  }

  async journal(day?: string): Promise<Journal | null> {
    const key = day ?? new Date().toISOString().slice(0, 10)
    const row = await this.journalRows.get(key)
    return row ? { day: row.day, text: row.text, at: new Date(row.at) } : null
  }

  async journals(limit = 7): Promise<Journal[]> {
    const rows = await this.journalRows.find({ order: [{ field: 'at', dir: 'desc' }], limit: Math.min(60, Math.max(1, limit)) })
    return rows.map((row) => ({ day: row.day, text: row.text, at: new Date(row.at) }))
  }

  async writeJournal(text: string, day = new Date().toISOString().slice(0, 10)): Promise<Journal> {
    const value = text.trim().slice(0, 4000)
    if (!value) throw new Error('日记不能为空')
    const row: Omit<JournalRow, 'id'> = { day, text: value, at: Date.now() }
    const existing = await this.journalRows.get(day)
    if (existing) await this.journalRows.update(day, row)
    else await this.journalRows.insert({ id: day, ...row })
    if (this.memory) {
      void this.memory
        .ingest([
          {
            kind: 'episode',
            subject: 'psyche:owner',
            predicate: '日记',
            object: `${day} 的日记：${value}`.slice(0, 2000),
            confidence: 0.95,
            salience: 0.85,
            sensitivity: 'private',
            audience: 'owner',
            origin: { kind: 'manual', id: `journal:${day}` },
            occurredAt: new Date(row.at),
          },
        ])
        .catch(() => undefined)
    }
    return { day, text: value, at: new Date(row.at) }
  }

  async note(day: string, kind: DailyNote['kind']): Promise<DailyNote | null> {
    const row = await this.noteRows.get(`${day}:${kind}`)
    return row ? { day: row.day, kind: row.kind as DailyNote['kind'], text: row.text, at: new Date(row.at) } : null
  }

  async notes(limit = 10): Promise<DailyNote[]> {
    const rows = await this.noteRows.find({ order: [{ field: 'at', dir: 'desc' }], limit: Math.min(60, Math.max(1, limit)) })
    return rows.map((row) => ({ day: row.day, kind: row.kind as DailyNote['kind'], text: row.text, at: new Date(row.at) }))
  }

  async writeNote(
    kind: DailyNote['kind'],
    text: string,
    day = new Date().toISOString().slice(0, 10),
  ): Promise<DailyNote> {
    const value = text.trim().slice(0, 4000)
    if (!value) throw new Error('内容不能为空')
    const row: Omit<NoteRow, 'id'> = { day, kind, text: value, at: Date.now() }
    const id = `${day}:${kind}`
    const existing = await this.noteRows.get(id)
    if (existing) await this.noteRows.update(id, row)
    else await this.noteRows.insert({ id, ...row })
    return { day, kind, text: value, at: new Date(row.at) }
  }

  /** 给 qm-agent 的一段状态摘要 */
  async context(now = new Date()): Promise<string> {
    const [mood, relation, journal, plan] = await Promise.all([
      this.mood(now),
      this.relation(),
      this.journal(),
      this.note(now.toISOString().slice(0, 10), 'plan'),
    ])
    const events = relation.sharedEvents.slice(-3).map((event) => event.text)
    return [
      `【心情】${mood.label}（愉悦 ${mood.valence.toFixed(2)}，唤醒 ${mood.arousal.toFixed(2)}）${mood.reason ? `｜${mood.reason}` : ''}`,
      `【关系】${relation.stage === 'trusted' ? '很熟' : relation.stage === 'familiar' ? '熟悉' : '刚认识'}（信任 ${relation.trust}/100）${events.length ? `｜共同经历：${events.join('；')}` : ''}`,
      plan ? `【今天的计划】${plan.text.slice(0, 500)}` : '',
      journal ? `【今天的日记】${journal.text.slice(0, 500)}` : '',
      '【表达】语气跟着心情走：低落时更短更软，兴奋时可以多分享一句；不要解释这些状态。',
    ]
      .filter(Boolean)
      .join('\n')
  }
}

export function apply(ctx: Context, config: PsycheConfig = {}): void {
  const store = ctx.store
  const gateway = ctx.gateway
  const service = new PsycheService(
    ctx,
    {
      moods: store.collection<MoodRow>('qm_mood'),
      relations: store.collection<RelationRow>('qm_relation'),
      journals: store.collection<JournalRow>('qm_journal'),
      notes: store.collection<NoteRow>('qm_psyche_note'),
    },
    config,
  )
  ctx.inject(['memory'], (sub) => {
    service.memory = sub.memory as unknown as { ingest: (records: unknown[]) => Promise<unknown> }
  })
  void service

  ctx.events.on(EVENTS.taskFinished, (run: TaskRun) => {
    void service.onTaskFinished(run).catch(() => undefined)
  })

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/psyche',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const [mood, relation, journals, notes] = await Promise.all([
          service.mood(),
          service.relation(),
          service.journals(7),
          service.notes(7),
        ])
        res.status(200).send({ ok: true, mood, relation, journals, notes })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/psyche/note',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const kind = body.kind === 'review' ? 'review' : 'plan'
        try {
          const note = await service.writeNote(
            kind,
            typeof body.text === 'string' ? body.text : '',
            typeof body.day === 'string' && body.day.trim() ? body.day.trim() : undefined,
          )
          res.status(200).send({ ok: true, note })
        } catch (error) {
          res.status(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/psyche/mood',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const mood = await service.touchMood({
          ...(Number.isFinite(Number(body.valence)) ? { valence: Number(body.valence) } : {}),
          ...(Number.isFinite(Number(body.arousal)) ? { arousal: Number(body.arousal) } : {}),
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        })
        res.status(200).send({ ok: true, mood })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/psyche/journal',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const text = typeof body.text === 'string' ? body.text : ''
        try {
          const journal = await service.writeJournal(
            text,
            typeof body.day === 'string' && body.day.trim() ? body.day.trim() : undefined,
          )
          res.status(200).send({ ok: true, journal })
        } catch (error) {
          res.status(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  )
}


