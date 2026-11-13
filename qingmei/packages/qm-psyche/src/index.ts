/**
 * 关系与日记：只记事实，不做“情绪状态机”。
 *
 * 像不像人由人格文件和模型决定；这里只提供可回忆的东西：
 * 一起完成/失败过什么、今天写了什么、今天打算做什么。
 */
import { Service, type Context } from 'cordis'
import { EVENTS, type Collection, type GatewayRequest, type GatewayResponse, type Row, type TaskRun } from '@qingmei/core'

export const name = 'qm-psyche'
export const inject = ['store', 'gateway']

export interface RelationEvent {
  at: Date
  text: string
  kind: 'done' | 'failed'
}

export interface Relation {
  events: RelationEvent[]
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

interface RelationRow extends Row {
  events_json: string
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

function parseLegacyEvents(raw: string | undefined): RelationEvent[] {
  try {
    const parsed = JSON.parse(raw ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => ({
      at: new Date(String((item as { at?: string }).at ?? Date.now())),
      text: String((item as { text?: string }).text ?? ''),
      kind: 'done' as const,
    }))
  } catch {
    return []
  }
}

function parseEvents(raw: string | undefined): RelationEvent[] {
  try {
    const parsed = JSON.parse(raw ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        at: new Date(String(item.at ?? Date.now())),
        text: String(item.text ?? ''),
        kind: item.kind === 'failed' ? 'failed' : 'done',
      }))
  } catch {
    return []
  }
}

class PsycheService extends Service {
  private readonly relationRows: Collection<RelationRow>
  private readonly journalRows: Collection<JournalRow>
  private readonly noteRows: Collection<NoteRow>
  memory: { ingest: (records: unknown[]) => Promise<unknown> } | undefined

  constructor(
    ctx: Context,
    collections: {
      relations: Collection<RelationRow>
      journals: Collection<JournalRow>
      notes: Collection<NoteRow>
    },
  ) {
    super(ctx, 'psyche')
    this.relationRows = collections.relations
    this.journalRows = collections.journals
    this.noteRows = collections.notes
  }

  async relation(): Promise<Relation> {
    const row = await this.relationRows.get('owner')
    if (!row) return { events: [], updatedAt: new Date() }
    // 兼容旧版：把 shared_events_json 迁移成纯事件（不再有 trust/阶段）
    const legacy = row as unknown as { shared_events_json?: string }
    const events = row.events_json ? parseEvents(row.events_json) : parseLegacyEvents(legacy.shared_events_json)
    return { events: events.slice(-40), updatedAt: new Date(row.updated_at) }
  }

  async recordEvent(text: string, kind: 'done' | 'failed' = 'done', now = new Date()): Promise<void> {
    const value = text.trim().slice(0, 300)
    if (!value) return
    const current = await this.relation()
    const events = [...current.events, { at: now, text: value, kind }].slice(-40)
    const row: Omit<RelationRow, 'id'> = { events_json: JSON.stringify(events), updated_at: now.getTime() }
    const existing = await this.relationRows.get('owner')
    if (existing) await this.relationRows.update('owner', row)
    else await this.relationRows.insert({ id: 'owner', ...row })
  }

  async onTaskFinished(run: TaskRun, now = new Date()): Promise<void> {
    if (run.status === 'done') await this.recordEvent(`一起完成：${run.title}`, 'done', now)
    else if (run.status === 'failed') await this.recordEvent(`失败：${run.title}`, 'failed', now)
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

  /** 给 qm-agent 的上下文：只给事实，不给“你现在的情绪” */
  async context(now = new Date()): Promise<string> {
    const [relation, journal, plan] = await Promise.all([
      this.relation(),
      this.journal(),
      this.note(now.toISOString().slice(0, 10), 'plan'),
    ])
    const events = relation.events.slice(-5).map((event) => event.text)
    return [
      events.length ? `【最近一起经历】${events.join('；')}` : '',
      plan ? `【今天的计划】${plan.text.slice(0, 500)}` : '',
      journal ? `【今天的日记】${journal.text.slice(0, 500)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
}

export function apply(ctx: Context): void {
  const store = ctx.store
  const gateway = ctx.gateway
  const service = new PsycheService(ctx, {
    relations: store.collection<RelationRow>('qm_relation'),
    journals: store.collection<JournalRow>('qm_journal'),
    notes: store.collection<NoteRow>('qm_psyche_note'),
  })
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
        const [relation, journals, notes] = await Promise.all([
          service.relation(),
          service.journals(7),
          service.notes(7),
        ])
        res.status(200).send({ ok: true, relation, journals, notes })
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
      path: '/api/v1/psyche/journal',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        try {
          const journal = await service.writeJournal(
            typeof body.text === 'string' ? body.text : '',
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

