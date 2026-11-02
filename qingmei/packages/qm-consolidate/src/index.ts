/**
 * @qingmei/qm-consolidate —— 夜间巩固（docs/09 §5 的最小版）。
 *
 * 每天低峰时段调一次 `memory.consolidate()`：同主题只留价值最高的几条，
 * 其余低置信/过旧事实软压缩（valid_to 置位，不删除）。结果落 `qm_memory_consolidation`，
 * 有压缩时给主人发一条简短报告；`POST /api/v1/memory/consolidate` 可手动触发。
 */
import type { Context } from 'cordis'
import {
  uid,
  type ChannelService,
  type ConsolidationReport,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type MemoryService,
  type Row,
  type StoreService,
} from '@qingmei/core'

export interface ConsolidateConfig {
  /** 每天几点跑，默认 4 点（本地时区） */
  hour?: number
}

export const name = 'qm-consolidate'
export const inject = ['memory', 'channel', 'gateway', 'store']

interface RunRow extends Row {
  at: number
  scanned: number
  compressed: number
}

export function apply(ctx: Context, config: ConsolidateConfig = {}): void {
  const memory = ctx.reflect.get('memory', false) as MemoryService | undefined
  const channel = ctx.reflect.get('channel', false) as ChannelService | undefined
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  const store = ctx.reflect.get('store', false) as StoreService | undefined
  if (!memory) throw new Error('[qm-consolidate] 缺少 memory 服务')
  if (!channel) throw new Error('[qm-consolidate] 缺少 channel 服务')
  if (!gateway) throw new Error('[qm-consolidate] 缺少 gateway 服务')
  if (!store) throw new Error('[qm-consolidate] 缺少 store 服务')

  const runs = store.collection<RunRow>('qm_memory_consolidation')
  const hour = Math.min(23, Math.max(0, Math.round(Number(config.hour ?? 4))))

  async function run(): Promise<ConsolidationReport> {
    const report = await memory.consolidate()
    await runs
      .insert({ id: uid('cons'), at: report.at.getTime(), scanned: report.scanned, compressed: report.compressed.length })
      .catch(() => undefined)

    if (report.compressed.length > 0) {
      await channel
        .send({
          channel: 'web',
          conversationId: 'owner',
          blocks: [
            {
              type: 'text',
              text: `🧠 记忆巩固：扫描 ${report.scanned} 条，压缩 ${report.compressed.length} 条低价值事实`,
            },
          ],
        })
        .catch(() => undefined)
    }
    return report
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  function schedule(): void {
    const now = new Date()
    const next = new Date(now)
    next.setHours(hour, 0, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    timer = setTimeout(() => {
      void run()
        .catch(() => undefined)
        .finally(() => schedule())
    }, next.getTime() - now.getTime())
    timer.unref?.()
  }
  schedule()
  ctx.effect(() => () => {
    if (timer) clearTimeout(timer)
    timer = null
  })

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/memory/consolidate',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const report = await run()
        res.status(200).send({
          ok: true,
          at: report.at.toISOString(),
          scanned: report.scanned,
          compressed: report.compressed.length,
        })
      },
    }),
  )
}

export const defaultExport = { name, inject, apply }
