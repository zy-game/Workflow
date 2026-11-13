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
  type ChannelService,
  type MissedPolicy,
  type Row,
  type Scheduled,
  type ScheduleInput,
  type TaskService,
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
/** 单次 tick 最多处理多少条到期记录 */
const TICK_BATCH = 500
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
  /** 绑定到任务账本：日程=带触发时间的任务 */
  task_id?: string | null
}

export class SqliteSchedule extends ScheduleService {
  readonly ctx: Context
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
    // 按 next_at 建索引：tick 不再全表扫，20 万条也只读「最早的一批」
    void (async () => {
      try {
        await store.ensureIndex(COLLECTION, ['next_at'])
      } catch {
        // 老库/只读场景下建不了索引也不影响功能，只是慢
      }
    })()
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
    const taskId = await this.createReminderTask(inserted)
    if (taskId) await this.collection.update(inserted.id, { task_id: taskId })
    return toScheduled({ ...inserted, task_id: taskId })
  }

  /** 日程 = 带 trigger 的任务：创建一条 scheduled 的 reminder 任务 */
  private async createReminderTask(row: ScheduleRow): Promise<string | undefined> {
    const tasks = this.ctx.get('task', false) as TaskService | undefined
    if (!tasks) return undefined
    const trigger = row.cron ? 'cron' : 'at'
    const schedule = row.cron
      ? { rrule: row.cron, ...(row.timezone ? { timezone: row.timezone } : {}) }
      : { at: new Date(row.next_at) }
    const task = await tasks
      .create({
        prompt: row.text,
        title: row.text.slice(0, 40),
        kind: 'reminder',
        status: 'scheduled',
        origin: 'schedule',
        trigger,
        schedule,
        target: { executorId: 'local' },
      })
      .catch(() => null)
    return task?.id
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
  private migrated = false

  /** 旧日程没有 task_id：启动后补建任务，保证「日程就是任务」对老数据也成立 */
  private async migrateLegacy(): Promise<void> {
    if (this.migrated) return
    this.migrated = true
    const rows = await this.collection.find({})
    for (const row of rows) {
      if (row.task_id || row.fired_at !== null) continue
      const taskId = await this.createReminderTask(row)
      if (taskId) await this.collection.update(row.id, { task_id: taskId })
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      // 只取最早的一批：按 next_at 升序 + limit，超出的留给下一个 tick（1 秒后）。
      // 之前是全表 find()，日程越多越慢，且与「到点提醒」这个场景完全不成比例。
      await this.migrateLegacy()
      const rows = await this.collection.find({ order: [{ field: 'next_at', dir: 'asc' }], limit: TICK_BATCH })
      for (const row of rows) {
        if (row.next_at > now) break
        try {
          await this.advance(row, now)
        } catch (error) {
          // 单条坏记录不能拖住其它提醒
          this.ctx.logger.warn(`[provider-schedule-sqlite] 记录 ${row.id} 推进失败：${messageOf(error)}`)
        }
      }
      if (rows.length === TICK_BATCH && rows[rows.length - 1]!.next_at <= now) {
        this.ctx.logger.warn(`[provider-schedule-sqlite] 单次到期超过 ${TICK_BATCH} 条，剩余留到下一次 tick`)
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
    const tasks = this.ctx.get('task', false) as TaskService | undefined
    const bound = Boolean(row.task_id && tasks)

    // 一次性：任务入队后退休；老数据没有 task_id 时保持原来的投递
    if (cron === null && everyMs === null) {
      if (bound) {
        const enqueued = await tasks!.enqueue(row.task_id!).catch(() => null)
        if (enqueued) {
          await this.collection.update(row.id, { fired_at: now })
          return
        }
      }
      this.ctx.events.emit(EVENTS.scheduleDue, toScheduled(row))
      await this.collection.update(row.id, { fired_at: now })
      return
    }

    if (cron !== null) {
      const timezone = row.timezone ?? undefined
      const next = nextCronTime(cron, new Date(now), timezone).getTime()
      if (this.shouldSkipMissed(row, now)) {
        if (bound) {
          await tasks!.finish(row.task_id!, { status: 'cancelled' }).catch(() => null)
          const taskId = await this.createReminderTask({ ...row, next_at: next, task_id: null })
          await this.collection.update(row.id, {
            next_at: next,
            ...(taskId ? { task_id: taskId } : { task_id: null }),
          })
          return
        }
        await this.collection.update(row.id, { next_at: next })
        return
      }
      if (bound) {
        const enqueued = await tasks!.enqueue(row.task_id!).catch(() => null)
        if (enqueued) {
          const taskId = await this.createReminderTask({ ...row, next_at: next, task_id: null })
          await this.collection.update(row.id, {
            next_at: next,
            ...(taskId ? { task_id: taskId } : { task_id: null }),
          })
          return
        }
      }
      this.ctx.events.emit(EVENTS.scheduleDue, toScheduled(row))
      await this.collection.update(row.id, { next_at: next })
      return
    }

    if (everyMs !== null) {
      const next = now + everyMs
      if (bound) {
        const enqueued = await tasks!.enqueue(row.task_id!).catch(() => null)
        if (enqueued) {
          const taskId = await this.createReminderTask({ ...row, next_at: next, task_id: null })
          await this.collection.update(row.id, {
            next_at: next,
            ...(taskId ? { task_id: taskId } : { task_id: null }),
          })
          return
        }
      }
      this.ctx.events.emit(EVENTS.scheduleDue, toScheduled(row))
      // 固定间隔按「从现在起算」重排：停机再久也只补发一次
      await this.collection.update(row.id, { next_at: next })
      return
    }

    this.ctx.events.emit(EVENTS.scheduleDue, toScheduled(row))
    await this.collection.update(row.id, { fired_at: now })
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

function deliver(ctx: Context, channel: ChannelService, item: Scheduled): void {
  void (async () => {
    try {
      const result = await channel.send({
        channel: item.channel,
        conversationId: item.conversationId,
        blocks: [{ type: 'text', text: `⏰ 提醒：${item.text}` }],
      })
      if (!result.ok) ctx.logger.warn(`[qm-schedule] 投递失败：${result.error ?? '未知'}`)
    } catch (error) {
      ctx.logger.warn(`[qm-schedule] 投递异常：${error instanceof Error ? error.message : String(error)}`)
    }
  })()
}

export function apply(ctx: Context, config: ScheduleConfig = {}): void {
  ctx.plugin(SqliteSchedule, config)
  ctx.inject(['channel'], (sub) => {
    sub.events.on(EVENTS.scheduleDue, (item: Scheduled) => deliver(sub, sub.channel, item))
  })
}

export const defaultExport = { name, inject, apply }




