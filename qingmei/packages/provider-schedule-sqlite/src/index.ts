/**
 * @qingmei/provider-schedule-sqlite —— 日程/提醒的持久化与到点触发。
 *
 * M2 只做一次性提醒与固定间隔；cron 与时区留到后续。
 * 到点后发 qm/schedule/due，由 qm-reminder 负责投递。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  ScheduleService,
  uid,
  type ChannelId,
  type Row,
  type Scheduled,
  type ScheduleInput,
  type StoreService,
} from '@qingmei/core'

export const name = 'provider-schedule-sqlite'
export const inject = ['store']

const COLLECTION = 'qm_schedule'

interface ScheduleRow extends Row {
  text: string
  channel: string
  conversation_id: string
  next_at: number
  every_ms: number | null
  fired_at: number | null
  created_at: number
}

export class SqliteSchedule extends ScheduleService {
  private readonly ctx: Context
  private readonly collection
  private readonly tickMs: number
  private timer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(ctx: Context, config: { tickMs?: number } = {}) {
    super(ctx)
    this.ctx = ctx
    const store = ctx.reflect.get('store', false) as StoreService | undefined
    if (!store) throw new Error('[provider-schedule-sqlite] 缺少 store 服务')
    this.collection = store.collection<ScheduleRow>(COLLECTION)
    this.tickMs = config.tickMs ?? 1000
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    ctx.effect(() => () => {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
    })
  }

  async create(input: ScheduleInput): Promise<Scheduled> {
    const now = Date.now()
    const nextAt = input.at
      ? input.at.getTime()
      : now + (input.everyMs ?? 60_000)
    const row: Omit<ScheduleRow, 'id'> = {
      text: input.text,
      channel: input.channel ?? 'web',
      conversation_id: input.conversationId ?? 'owner',
      next_at: nextAt,
      every_ms: input.at ? null : (input.everyMs ?? 60_000),
      fired_at: null,
      created_at: now,
    }
    const inserted = await this.collection.insert(row)
    return toScheduled(inserted)
  }

  async list(): Promise<Scheduled[]> {
    const rows = await this.collection.find({ order: [{ field: 'next_at', dir: 'asc' }] })
    return rows.map(toScheduled)
  }

  async cancel(id: string): Promise<boolean> {
    return this.collection.delete(id)
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      const rows = await this.collection.find()
      for (const row of rows) {
        if (row.fired_at !== null) continue
        if (row.next_at > now) continue
        this.ctx.events.emit(EVENTS.scheduleDue, toScheduled(row))
        if (row.every_ms && row.every_ms > 0) {
          await this.collection.update(row.id, { next_at: now + row.every_ms, fired_at: now })
        } else {
          await this.collection.update(row.id, { fired_at: now })
        }
      }
    } catch (error) {
      this.ctx.logger.warn(`[provider-schedule-sqlite] tick 失败：${messageOf(error)}`)
    } finally {
      this.ticking = false
    }
  }
}

function toScheduled(row: ScheduleRow): Scheduled {
  return {
    id: row.id,
    text: row.text,
    channel: row.channel as ChannelId,
    conversationId: row.conversation_id,
    nextAt: new Date(row.next_at),
    everyMs: row.every_ms,
    firedAt: row.fired_at === null ? null : new Date(row.fired_at),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: Context, config: { tickMs?: number } = {}): void {
  ctx.plugin(SqliteSchedule, config)
}

export const defaultExport = { name, inject, apply }
