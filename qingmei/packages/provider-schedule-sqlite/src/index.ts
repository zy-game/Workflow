/**
 * @qingmei/provider-schedule-sqlite —— 日程/提醒的持久化与到点触发。
 *
 * 支持三类规则：一次性（at）、固定间隔（everyMs）、五段式 cron（cron + timezone）。
 * cron 的下一次触发时刻由 @qingmei/core 的 nextCronTime 计算，时区换算不在这里重复实现。
 * 到点后发 qm/schedule/due，由 qm-reminder 负责投递。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  ScheduleService,
  nextCronTime,
  systemTimeZone,
  type ChannelId,
  type MissedPolicy,
  type Row,
  type Scheduled,
  type ScheduleInput,
  type StoreService,
} from '@qingmei/core'

export const name = 'provider-schedule-sqlite'
export const inject = ['store']

export interface ScheduleConfig {
  tickMs?: number
  /** cron 未指定时区时用的 IANA 时区；缺省用进程时区 */
  defaultTimezone?: string
}

const COLLECTION = 'qm_schedule'
const DEFAULT_EVERY_MS = 60_000

interface ScheduleRow extends Row {
  text: string
  channel: string
  conversation_id: string
  next_at: number
  every_ms: number | null
  /** 老记录没有这几个字段，读取时按缺省处理 */
  cron?: string | null
  timezone?: string | null
  missed_policy?: MissedPolicy
  fired_at: number | null
  created_at: number
}

export class SqliteSchedule extends ScheduleService {
  private readonly ctx: Context
  private readonly collection
  private readonly tickMs: number
  private readonly defaultTimezone: string
  private timer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(ctx: Context, config: ScheduleConfig = {}) {
    super(ctx)
    this.ctx = ctx
    const store = ctx.reflect.get('store', false) as StoreService | undefined
    if (!store) throw new Error('[provider-schedule-sqlite] 缺少 store 服务')
    this.collection = store.collection<ScheduleRow>(COLLECTION)
    this.tickMs = config.tickMs ?? 1000
    this.defaultTimezone = config.defaultTimezone?.trim() || systemTimeZone()
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    ctx.effect(() => () => {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
    })
  }

  async create(input: ScheduleInput): Promise<Scheduled> {
    const text = input.text?.trim()
    if (!text) throw new Error('提醒内容不能为空')
    if (input.at && input.cron) throw new Error('at 与 cron 只能二选一')
    if (input.at && input.everyMs !== undefined) throw new Error('at 与 everyMs 只能二选一')
    if (input.cron && input.everyMs !== undefined) throw new Error('cron 与 everyMs 只能二选一')

    const now = Date.now()
    const cron = input.cron?.trim() || null
    // 缺省时区在创建时定下来并落库：进程换时区不该让已有日程漂移
    const timezone = cron ? input.timezone?.trim() || this.defaultTimezone : null
    const everyMs = cron || input.at ? null : (input.everyMs ?? DEFAULT_EVERY_MS)
    if (everyMs !== null && (!Number.isFinite(everyMs) || everyMs <= 0)) {
      throw new Error('everyMs 必须是正数')
    }

    let nextAt: number
    if (cron) {
      // 表达式与时区都在这里校验：写不进去的规则不如直接报错
      nextAt = nextCronTime(cron, new Date(now), timezone ?? undefined).getTime()
    } else if (input.at) {
      nextAt = input.at.getTime()
      if (!Number.isFinite(nextAt)) throw new Error('at 不是有效时间')
    } else {
      nextAt = now + everyMs!
    }

    const row: Omit<ScheduleRow, 'id'> = {
      text,
      channel: input.channel ?? 'web',
      conversation_id: input.conversationId ?? 'owner',
      next_at: nextAt,
      every_ms: everyMs,
      cron,
      timezone,
      missed_policy: input.missedPolicy ?? 'fire-once',
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

  /** 扫一遍到期记录。公开是为了让测试按需推进，不依赖真实计时器。 */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      const rows = await this.collection.find()
      for (const row of rows) {
        try {
          await this.advance(row, now)
        } catch (error) {
          // 单条坏记录不能拖住其它提醒
          this.ctx.logger.warn(`[provider-schedule-sqlite] 记录 ${row.id} 推进失败：${messageOf(error)}`)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private async advance(row: ScheduleRow, now: number): Promise<void> {
    const cron = row.cron ?? null
    const everyMs = row.every_ms && row.every_ms > 0 ? row.every_ms : null

    // 一次性：发过就退休
    if (cron === null && everyMs === null) {
      if (row.fired_at !== null) return
      if (row.next_at > now) return
      this.ctx.events.emit(EVENTS.scheduleDue, toScheduled(row))
      await this.collection.update(row.id, { fired_at: now })
      return
    }

    if (row.next_at > now) return
    // 周期行不写 fired_at：它一直是「待触发」，否则会从 schedule_list 里消失
    if (cron !== null) {
      const timezone = row.timezone ?? undefined
      const next = nextCronTime(cron, new Date(now), timezone).getTime()
      if (this.shouldSkipMissed(row, now)) {
        await this.collection.update(row.id, { next_at: next })
        return
      }
      this.ctx.events.emit(EVENTS.scheduleDue, toScheduled(row))
      await this.collection.update(row.id, { next_at: next })
      return
    }

    this.ctx.events.emit(EVENTS.scheduleDue, toScheduled(row))
    // 固定间隔按「从现在起算」重排：停机再久也只补发一次
    await this.collection.update(row.id, { next_at: now + everyMs! })
  }

  /**
   * skip 策略下，判断是否连「下一次」也错过了。
   *
   * 用一个周期来区分「迟到」与「错过」：到期时刻之后的那一次也已经过去，
   * 说明至少漏了整整一个周期，此时不再补发。
   */
  private shouldSkipMissed(row: ScheduleRow, now: number): boolean {
    if ((row.missed_policy ?? 'fire-once') !== 'skip') return false
    const cron = row.cron
    if (!cron) return false
    const following = nextCronTime(cron, new Date(row.next_at), row.timezone ?? undefined).getTime()
    return following <= now
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
    cron: row.cron ?? null,
    timezone: row.timezone ?? null,
    missedPolicy: row.missed_policy ?? 'fire-once',
    firedAt: row.fired_at === null ? null : new Date(row.fired_at),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: Context, config: ScheduleConfig = {}): void {
  ctx.plugin(SqliteSchedule, config)
}

export const defaultExport = { name, inject, apply }
