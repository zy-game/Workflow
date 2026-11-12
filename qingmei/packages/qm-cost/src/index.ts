/**
 * @qingmei/qm-cost —— 成本与用量：DeepSeek 余额快照 + embedding token 记账。
 *
 * 余额差近似当日花费（DSH 不透出 usage）；embedding 每次调用的 usage 由 provider 记账。
 * 对主人暴露一个 cost 服务，聊天命令「今日用量」直接读它，不经过模型。
 *
 * key 来源：config.apiKey → env QM_DEEPSEEK_API_KEY / DEEPSEEK_API_KEY → credentialsPath。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import {
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

interface EmbeddingUsageRow extends Row {
  day: string
  tokens: number
  calls: number
  at: number
}

export interface CostSummary {
  day: string
  balance: number | null
  currency: string
  spentSinceYesterday: number | null
  embeddingTodayTokens: number
  embeddingTodayCalls: number
  embeddingMonthTokens: number
  text: string
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
  const usage = store.collection<EmbeddingUsageRow>('qm_embedding_usage')
  const baseUrl = (config.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const fetchImpl = config.fetchImpl ?? fetch

  class CostService extends Service {
    constructor(context: Context) {
      super(context, 'cost')
    }

    async summary(now: Date = new Date()): Promise<CostSummary> {
      const rows = await snapshots.find({ order: [{ field: 'day', dir: 'desc' }], limit: 14 })
      const latest = rows[0] ?? null
      const yesterday = rows[1] ?? null
      const spent = latest && yesterday ? Number((yesterday.total - latest.total).toFixed(4)) : null
      const day = now.toISOString().slice(0, 10)
      const month = day.slice(0, 7)
      const usages = await usage.find({})
      const todayUsages = usages.filter((row) => row.day === day)
      const todayTokens = todayUsages.reduce((sum, row) => sum + Number(row.tokens ?? 0), 0)
      const todayCalls = todayUsages.reduce((sum, row) => sum + Number(row.calls ?? 0), 0)
      const monthTokens = usages
        .filter((row) => String(row.day).startsWith(month))
        .reduce((sum, row) => sum + Number(row.tokens ?? 0), 0)
      const currency = latest?.currency ?? 'CNY'
      const lines = [
        `【今日用量】${day}`,
        `- 余额：${latest ? `${latest.total} ${currency}` : '未取到（检查 DeepSeek key）'}`,
        `- 今日花费：${spent === null ? '暂无昨日快照可比' : `${spent} ${currency}`}`,
        `- embedding：今日 ${todayTokens} tokens / ${todayCalls} 次；本月 ${monthTokens} tokens`,
      ]
      return {
        day,
        balance: latest ? latest.total : null,
        currency,
        spentSinceYesterday: spent,
        embeddingTodayTokens: todayTokens,
        embeddingTodayCalls: todayCalls,
        embeddingMonthTokens: monthTokens,
        text: lines.join('\n'),
      }
    }
  }

  new CostService(ctx)

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
        const cost = ctx.get('cost', false) as CostService | undefined
        if (!cost) {
          res.status(503).send({ ok: false, error: '成本服务未就绪' })
          return
        }
        const summary = await cost.summary()
        const items = await snapshots.find({ order: [{ field: 'day', dir: 'desc' }], limit: 14 })
        res.status(200).send({ ok: true, ...summary, items })
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

  const timer = setInterval(() => {
    if (new Date().getHours() === 6) void refresh()
  }, 60 * 60_000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))
}

export const defaultExport = { name, inject, apply }
