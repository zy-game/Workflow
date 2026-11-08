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
  InvalidScheduleError,
  ScheduleService,
  nextCronTime,
  systemTimeZone,
  type ChannelId,
  type MissedPolicy,
  type Row,
  type Scheduled,
  type ScheduleInput,
  type SchedulePatch,
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
  paused_at?: number | null
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
    const store = ctx.store
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
    if (!text) throw new InvalidScheduleError('提醒内容不能为空')
    if (input.at && input.cron) throw new InvalidScheduleError('at 与 cron 只能二选一')
    if (input.at && input.everyMs !== undefined) throw new InvalidScheduleError('at 与 everyMs 只能二选一')
    if (input.cron && input.everyMs !== undefined) throw new InvalidScheduleError('cron 与 everyMs 只能二选一')

    const now = Date.now()
    const cron = input.cron?.trim() || null
    // 缺省时区在创建时定下来并落库：进程换时区不该让已有日程漂移
    const timezone = cron ? input.timezone?.trim() || this.defaultTimezone : null
    const everyMs = cron || input.at ? null : (input.everyMs ?? DEFAULT_EVERY_MS)
    if (everyMs !== null && (!Number.isFinite(everyMs) || everyMs <= 0)) {
      throw new InvalidScheduleError('everyMs 必须是正数')
    }

    let nextAt: number
    if (cron) {
      // 表达式与时区都在这里校验：写不进去的规则不如直接报错
      nextAt = nextTrigger(cron, now, timezone ?? undefined)
    } else if (input.at) {
      nextAt = input.at.getTime()
      if (!Number.isFinite(nextAt)) throw new InvalidScheduleError('at 不是有效时间')
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
      paused_at: null,
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

  /**
   * 改内容或规则。规则字段（at / everyMs / cron）最多给一个，给了就整体替换：
   * 旧规则留下的 cron / timezone / every_ms 会被一起清掉，nextAt 从「现在」重算。
   */
  async update(id: string, patch: SchedulePatch): Promise<Scheduled | null> {
    const row = await this.collection.get(id)
    if (!row || row.fired_at !== null) return null

    const changes: Partial<ScheduleRow> = {}
    if (patch.text !== undefined) {
      const text = patch.text.trim()
      if (!text) throw new InvalidScheduleError('提醒内容不能为空')
      changes.text = text
    }

    const ruleFields = [patch.at !== undefined, patch.everyMs !== undefined, patch.cron !== undefined]
    if (ruleFields.filter(Boolean).length > 1) {
      throw new InvalidScheduleError('at / everyMs / cron 只能给一个')
    }
    const now = Date.now()
    if (patch.cron !== undefined) {
      const cron = patch.cron.trim()
      if (!cron) throw new InvalidScheduleError('cron 不能为空')
      const timezone = patch.timezone?.trim() || row.timezone || this.defaultTimezone
      Object.assign(changes, {
        cron,
        timezone,
        every_ms: null,
        next_at: nextTrigger(cron, now, timezone),
      })
    } else if (patch.at !== undefined) {
      const nextAt = patch.at.getTime()
      if (!Number.isFinite(nextAt)) throw new InvalidScheduleError('at 不是有效时间')
      Object.assign(changes, { cron: null, timezone: null, every_ms: null, next_at: nextAt })
    } else if (patch.everyMs !== undefined) {
      const everyMs = patch.everyMs
      if (!Number.isFinite(everyMs) || everyMs <= 0) throw new InvalidScheduleError('everyMs 必须是正数')
      Object.assign(changes, { cron: null, timezone: null, every_ms: everyMs, next_at: now + everyMs })
    } else if (patch.timezone !== undefined && row.cron) {
      // 只改时区：cron 的触发点要跟着换到新时区
      const timezone = patch.timezone.trim() || this.defaultTimezone
      Object.assign(changes, {
        timezone,
        next_at: nextTrigger(row.cron, now, timezone),
      })
    }
    if (patch.missedPolicy !== undefined) changes.missed_policy = patch.missedPolicy

    if (Object.keys(changes).length > 0) await this.collection.update(id, changes)
    const updated = await this.collection.get(id)
    return updated ? toScheduled(updated) : null
  }

  async pause(id: string): Promise<boolean> {
    const row = await this.collection.get(id)
    if (!row) return false
    if (row.paused_at) return true
    await this.collection.update(id, { paused_at: Date.now() })
    return true
  }

  /**
   * 继续：周期日程从「现在」重排，避免一恢复就补发一串；
   * 一次性日程保持原时间（已经过期就下一轮 tick 立即触发）。
   */
  async resume(id: string): Promise<boolean> {
    const row = await this.collection.get(id)
    if (!row) return false
    if (!row.paused_at) return true
    if (row.fired_at !== null) return false

    const now = Date.now()
    const cron = row.cron ?? null
    const everyMs = row.every_ms && row.every_ms > 0 ? row.every_ms : null
    let nextAt = row.next_at
    if (cron !== null) nextAt = nextTrigger(cron, now, row.timezone ?? undefined)
    else if (everyMs !== null) nextAt = now + everyMs

    await this.collection.update(id, { next_at: nextAt, paused_at: null })
    return true
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
    // fired_at 只有一次性行会写；旧版 every_ms 行也写过一次，同样按退休处理。
    // 新周期行（cron / everyMs）从不写 fired_at，所以这条不会误伤重排。
    if (row.fired_at !== null) return
    // 暂停的行只保留 next_at，不推进也不触发
    if (row.paused_at) return
    if (row.next_at > now) return

    const cron = row.cron ?? null
    const everyMs = row.every_ms && row.every_ms > 0 ? row.every_ms : null

    // 一次性：发过就退休
    if (cron === null && everyMs === null) {
      this.ctx.events.emit(EVENTS.scheduleDue, toScheduled(row))
      await this.collection.update(row.id, { fired_at: now })
      return
    }

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
    pausedAt: row.paused_at ? new Date(row.paused_at) : null,
    firedAt: row.fired_at === null ? null : new Date(row.fired_at),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 校验 cron 并算出下一次触发。
 *
 * cron 解析/时区错误一律改写成 InvalidScheduleError，
 * 接口层据此返回 400，而不是把「用户写错表达式」记成服务端 500。
 */
function nextTrigger(cron: string, now: number, timezone?: string): number {
  try {
    return nextCronTime(cron, new Date(now), timezone).getTime()
  } catch (error) {
    throw new InvalidScheduleError(messageOf(error))
  }
}

export function apply(ctx: Context, config: ScheduleConfig = {}): void {
  ctx.plugin(SqliteSchedule, config)
}

export const defaultExport = { name, inject, apply }
