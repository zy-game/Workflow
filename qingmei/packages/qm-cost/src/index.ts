/**
 * @qingmei/qm-cost —— DeepSeek 余额与每日花费快照。
 *
 * 只读官方 `GET /user/balance`，不碰对话、不改额度。DSH 不透出 usage，余额差是当前唯一
 * 可靠的成本信号：每天取一次余额，用前一天的差值近似当日花费。
 *
 * key 来源优先级：config.apiKey → env QM_DEEPSEEK_API_KEY / DEEPSEEK_API_KEY →
 * credentialsPath（默认 ~/.dsh/.credentials.yaml，只读第一处 DEEPSEEK_API_KEY）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from 'cordis'
import {
  uid,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type Row,
  type StoreService,
} from '@qingmei/core'

export const name = 'qm-cost'
export const inject = ['store', 'gateway']

export interface CostConfig {
  apiKey?: string
  baseUrl?: string
  credentialsPath?: string
  /** 测试注入 */
  fetchImpl?: typeof fetch
}

interface SnapshotRow extends Row {
  day: string
  total: number
  granted: number
  toppedUp: number
  currency: string
  at: number
}

interface BalanceResponse {
  is_available?: boolean
  balance_infos?: { currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }[]
}

function resolveKey(config: CostConfig): string | null {
  const fromEnv = process.env.QM_DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY
  if (fromEnv) return fromEnv.trim()
  if (config.apiKey) return config.apiKey.trim()
  const file = config.credentialsPath ?? path.join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const match = /DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?/.exec(text)
  return match ? match[1]!.trim() : null
}

export function apply(ctx: Context, config: CostConfig = {}): void {
  const store = ctx.store as StoreService
  const gateway = ctx.gateway as GatewayService
  const snapshots = store.collection<SnapshotRow>('qm_cost_snapshot')
  const baseUrl = (config.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const fetchImpl = config.fetchImpl ?? fetch

  async function refresh(): Promise<{ snapshot: SnapshotRow; changed: boolean } | { error: string }> {
    const key = resolveKey(config)
    if (!key) return { error: '没有 DeepSeek key（env QM_DEEPSEEK_API_KEY 或 ~/.dsh/.credentials.yaml）' }
    try {
      const response = await fetchImpl(`${baseUrl}/user/balance`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return { error: `余额接口 HTTP ${response.status}` }
      const body = (await response.json()) as BalanceResponse
      const info = body.balance_infos?.[0]
      if (!info) return { error: '余额接口没有 balance_infos' }
      const day = new Date().toISOString().slice(0, 10)
      const existing = await snapshots.get(day)
      const row: SnapshotRow = {
        id: day,
        day,
        total: Number(info.total_balance ?? 0),
        granted: Number(info.granted_balance ?? 0),
        toppedUp: Number(info.topped_up_balance ?? 0),
        currency: String(info.currency ?? 'CNY'),
        at: Date.now(),
      }
      const changed = !existing || existing.total !== row.total
      if (existing) await snapshots.update(day, row)
      else await snapshots.insert(row)
      return { snapshot: row, changed }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/cost',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const rows = await snapshots.find({ order: [{ field: 'day', dir: 'desc' }], limit: 14 })
        const today = rows[0] ?? null
        const yesterday = rows[1] ?? null
        res.status(200).send({
          ok: true,
          latest: today,
          spentSinceYesterday:
            today && yesterday ? Number((yesterday.total - today.total).toFixed(4)) : null,
          items: rows,
        })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/cost/refresh',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const result = await refresh()
        if ('error' in result) {
          res.status(503).send({ ok: false, error: result.error })
          return
        }
        res.status(200).send({ ok: true, ...result })
      },
    }),
  )

  // 进程内每天 06:00 自动取一次；没有 key 时静默跳过，不刷错误
  const timer = setInterval(() => {
    const hour = new Date().getHours()
    if (hour === 6) void refresh()
  }, 60 * 60_000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))
}

export const defaultExport = { name, inject, apply }
export { uid }
