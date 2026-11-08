/**
 * @qingmei/qm-rest —— W5 休息侧（服务端最小版）。
 *
 * 依据 docs/15 §8：参数是产品默认值，不是医学建议。
 *   - 连续活跃 90 分钟 → 建议离开屏幕 10 分钟（同一周期不重复）
 *   - 23:30 后仍有活动 → 提醒收工（每天一次）
 *   - 最近 7 天有 6 天都在用 → 建议安排一天低强度（每周一次）
 *
 * 活跃只统计「用户消息」时间戳（不读内容），不需要 PC/手机客户端。
 */
import type { Context } from 'cordis'
import {
  type ChannelService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type Row,
  type StoreService,
} from '@qingmei/core'

export interface RestConfig {
  tickMs?: number
  clock?: () => Date
  /** 连续活跃窗口（分钟） */
  focusMinutes?: number
  /** 收工提醒时间 */
  windDown?: string
  /** 建议降强度的连续天数 */
  streakDays?: number
}

export const name = 'qm-rest'
export const inject = ['store', 'channel', 'gateway']

interface RestRow extends Row {
  last_break_at: number
  last_wind_down_day: string
  last_streak_week: string
}

interface MessageRow extends Row {
  role: string
  created_at: number
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export function apply(ctx: Context, config: RestConfig = {}): void {
  const store = ctx.store
  const channel = ctx.channel
  const gateway = ctx.gateway
  if (!channel) throw new Error('[qm-rest] 缺少 channel 服务')
  if (!gateway) throw new Error('[qm-rest] 缺少 gateway 服务')

  const messages = store.collection<MessageRow>('qm_message')
  const states = store.collection<RestRow>('qm_rest_state')
  const now = () => (config.clock ? config.clock() : new Date())
  const focusMs = Math.max(30, config.focusMinutes ?? 90) * 60_000
  const [windHour, windMinute] = parseClock(config.windDown ?? '23:30')
  const streakTarget = Math.max(2, config.streakDays ?? 6)
  let ticking = false

  async function getState(): Promise<RestRow> {
    const rows = await states.find({})
    if (rows[0]) return rows[0]
    const row: RestRow = { id: 'state', last_break_at: 0, last_wind_down_day: '', last_streak_week: '' }
    await states.insert(row)
    return row
  }

  async function saveState(row: RestRow): Promise<void> {
    await states.update(row.id, row)
  }

  async function userActivity(fromMs: number, toMs: number): Promise<number[]> {
    const rows = await messages.find({})
    return rows
      .filter((row) => row.role === 'user' && row.created_at >= fromMs && row.created_at <= toMs)
      .map((row) => row.created_at)
      .sort((a, b) => a - b)
  }

  async function tick(): Promise<string[]> {
    if (ticking) return []
    ticking = true
    try {
      const at = now()
      const nowMs = at.getTime()
      const sent: string[] = []
      const state = await getState()

      // 90 分钟连续活跃 → 建议休息（同一周期最多一次）
      const active = await userActivity(nowMs - focusMs, nowMs)
      if (active.length > 0 && nowMs - state.last_break_at >= focusMs) {
        await say(
          `☕ 已经连续忙了约 ${Math.round(focusMs / 60_000)} 分钟。建议离开屏幕 10 分钟，回来再继续。`,
        )
        state.last_break_at = nowMs
        await saveState(state)
        sent.push('break')
      }

      // 23:30 后仍有活动 → 收工提醒（每天一次）
      const day = dayKey(at)
      const minutes = at.getHours() * 60 + at.getMinutes()
      if (minutes >= windHour * 60 + windMinute && state.last_wind_down_day !== day) {
        const recent = await userActivity(nowMs - 30 * 60_000, nowMs)
        if (recent.length > 0) {
          await say('🌙 已经 23:30 了，今天先收工吧。剩下的明天做，青梅会记得。')
          state.last_wind_down_day = day
          await saveState(state)
          sent.push('wind-down')
        }
      }

      // 最近 N 天有 streakTarget 天活跃 → 建议低强度一天（每周一次）
      const week = weekKey(at)
      if (state.last_streak_week !== week) {
        const start = nowMs - (streakTarget + 1) * DAY
        const recent = await userActivity(start, nowMs)
        const days = new Set(recent.map((ts) => dayKey(new Date(ts))))
        if (days.size >= streakTarget) {
          await say(`📆 最近 ${days.size} 天都在忙。建议挑一天低强度，别把恢复需求拖到崩。`)
          state.last_streak_week = week
          await saveState(state)
          sent.push('streak')
        }
      }
      return sent
    } finally {
      ticking = false
    }
  }

  async function say(text: string): Promise<void> {
    await channel
      .send({ channel: 'web', conversationId: 'owner', blocks: [{ type: 'text', text }] })
      .catch(() => undefined)
  }

  const timer =
    config.tickMs === 0 ? null : setInterval(() => void tick().catch(() => undefined), config.tickMs ?? 5 * 60_000)
  timer?.unref?.()
  ctx.effect(() => () => {
    if (timer) clearInterval(timer)
  })

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/rest',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const state = await getState()
        res.status(200).send({
          ok: true,
          state: {
            lastBreakAt: state.last_break_at ? new Date(state.last_break_at) : null,
            lastWindDownDay: state.last_wind_down_day || null,
            lastStreakWeek: state.last_streak_week || null,
          },
        })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/rest/tick',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        res.status(200).send({ ok: true, sent: await tick() })
      },
    }),
  )
}

function parseClock(value: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return [23, 30]
  return [Math.min(23, Number(match[1])), Math.min(59, Number(match[2]))]
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function weekKey(date: Date): string {
  const start = new Date(date.getFullYear(), 0, 1)
  const week = Math.floor((date.getTime() - start.getTime()) / (7 * DAY))
  return `${date.getFullYear()}-W${week}`
}

export const defaultExport = { name, inject, apply }
