/**
 * @qingmei/qm-memory-hotspot —— A4：记忆热点打分 + 周报（服务端最小版）。
 *
 * 夜间批处理（默认 03:00）按 `hits`/年龄做小步调整，外面包三层 A 类约束（docs/12）：
 *   1. 单次调整幅度 ≤ maxDelta（默认 0.05）
 *   2. 单次调整条数 ≤ maxRatio（默认 10%，至少 1 条）
 *   3. 只改 salience，不删除、不改内容
 * 每次调整落 `qm_memory_hotspot`，可一键回滚。
 *
 * 周报（默认周一 09:00）汇总事实总数、热点、长期未用、最近调整，推给 owner。
 */
import type { Context } from 'cordis'
import {
  uid,
  type AuditService,
  type ChannelService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type Row,
  type StoreService,
} from '@qingmei/core'

export interface HotspotConfig {
  auto?: boolean
  hotHour?: number
  weekDay?: number
  weekHour?: number
  maxDelta?: number
  maxRatio?: number
  clock?: () => Date
}

export const name = 'qm-memory-hotspot'
export const inject = ['store', 'channel', 'gateway']

const DAY = 24 * 60 * 60 * 1000
const HOT_COLLECTION = 'qm_memory_hotspot'
const WEEKLY_COLLECTION = 'qm_memory_weekly'

interface FactRow extends Row {
  subject: string
  predicate: string
  object: string
  audience: string
  salience: number
  confidence: number
  created_at: number
  last_fired_at?: number | null
  hits?: number
  valid_to?: number | null
}

interface Change {
  id: string
  subject: string
  before: number
  after: number
  reason: string
}

interface HotspotRow extends Row {
  at: number
  scanned: number
  changes_json: string
  status: string
}

interface WeeklyRow extends Row {
  week: string
  at: number
  markdown: string
}

export function apply(ctx: Context, config: HotspotConfig = {}): void {
  const store = ctx.reflect.get('store', false) as StoreService | undefined
  const channel = ctx.reflect.get('channel', false) as ChannelService | undefined
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!store) throw new Error('[qm-memory-hotspot] 缺少 store 服务')
  if (!channel) throw new Error('[qm-memory-hotspot] 缺少 channel 服务')
  if (!gateway) throw new Error('[qm-memory-hotspot] 缺少 gateway 服务')

  const facts = store.collection<FactRow>('qm_mem_fact')
  const runs = store.collection<HotspotRow>(HOT_COLLECTION)
  const weeklies = store.collection<WeeklyRow>(WEEKLY_COLLECTION)
  const audit = ctx.reflect.get('audit', false) as AuditService | undefined
  const now = () => (config.clock ? config.clock() : new Date())
  const maxDelta = Math.min(0.2, Math.max(0.01, config.maxDelta ?? 0.05))
  const maxRatio = Math.min(1, Math.max(0.001, config.maxRatio ?? 0.1))

  async function runHotspot(): Promise<{ id: string; scanned: number; changes: Change[] }> {
    const at = now().getTime()
    const rows = (await facts.find({})).filter(
      (row) => (row.valid_to ?? null) === null && row.audience === 'owner',
    )
    const candidates: Change[] = []
    for (const row of rows) {
      const hits = row.hits ?? 0
      const ageDays = (at - row.created_at) / DAY
      let delta = 0
      let reason = ''
      if (hits >= 3 && row.salience < 0.95) {
        delta = Math.min(maxDelta, 0.05)
        reason = `常用（${hits} 次）`
      } else if (hits === 0 && ageDays > 30 && row.salience > 0.2) {
        delta = -Math.min(maxDelta, 0.05)
        reason = `长期未用（${Math.floor(ageDays)} 天）`
      }
      if (delta === 0) continue
      const after = Math.min(1, Math.max(0.1, row.salience + delta))
      if (Math.abs(after - row.salience) < 0.001) continue
      candidates.push({ id: row.id, subject: row.subject, before: row.salience, after, reason })
    }

    const cap = Math.max(1, Math.ceil(rows.length * maxRatio))
    const picked = candidates
      .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
      .slice(0, cap)
    for (const change of picked) {
      await facts.update(change.id, { salience: change.after })
    }
    const row: HotspotRow = {
      id: `hot_${at.toString(36)}`,
      at,
      scanned: rows.length,
      changes_json: JSON.stringify(picked),
      status: 'applied',
    }
    await runs.insert(row)
    await audit
      ?.append({
        at: new Date(at),
        actorId: 'system',
        channel: 'web',
        action: 'memory.hotspot.adjust',
        target: row.id,
        detail: { scanned: rows.length, changed: picked.length },
        traceId: uid('trace'),
      })
      .catch(() => undefined)
    return { id: row.id, scanned: rows.length, changes: picked }
  }

  async function rollback(id: string): Promise<boolean> {
    const row = await runs.get(id)
    if (!row || row.status !== 'applied') return false
    const changes = JSON.parse(row.changes_json) as Change[]
    for (const change of changes) {
      await facts.update(change.id, { salience: change.before })
    }
    await runs.update(id, { status: 'rolled_back' })
    await audit
      ?.append({
        at: now(),
        actorId: 'owner',
        channel: 'web',
        action: 'memory.hotspot.rollback',
        target: id,
        detail: { reverted: changes.length },
        traceId: uid('trace'),
      })
      .catch(() => undefined)
    return true
  }

  async function weekly(): Promise<WeeklyRow> {
    const at = now()
    const week = weekKey(at)
    const rows = (await facts.find({})).filter(
      (row) => (row.valid_to ?? null) === null && row.audience === 'owner',
    )
    const hot = rows.filter((row) => (row.hits ?? 0) >= 3)
    const cold = rows.filter((row) => (row.hits ?? 0) === 0 && (at.getTime() - row.created_at) / DAY > 30)
    const recent = (await runs.find({}))
      .filter((row) => row.status === 'applied' && at.getTime() - row.at < 7 * DAY)
      .reduce((sum, row) => sum + (JSON.parse(row.changes_json) as Change[]).length, 0)
    const top = [...rows].sort((a, b) => (b.hits ?? 0) - (a.hits ?? 0)).slice(0, 5)
    const lines = [
      `# 记忆周报 · ${week}`,
      '',
      `- 事实：${rows.length} 条（热点 ${hot.length}，长期未用 ${cold.length}）`,
      `- 本周自动调整：${recent} 条（可回滚）`,
    ]
    if (top.length > 0) {
      lines.push('', '## 常用记忆')
      for (const row of top) lines.push(`- ${row.subject} / ${row.predicate} / ${row.object}（${row.hits ?? 0} 次）`)
    }
    const markdown = lines.join('\n')
    const existing = (await weeklies.find({})).find((row) => row.week === week)
    const row: WeeklyRow = {
      id: existing?.id ?? `wk_${at.getTime().toString(36)}`,
      week,
      at: at.getTime(),
      markdown,
    }
    if (existing) await weeklies.update(existing.id, row)
    else await weeklies.insert(row)
    await channel
      .send({ channel: 'web', conversationId: 'owner', blocks: [{ type: 'text', text: markdown }] })
      .catch(() => undefined)
    return row
  }

  if (config.auto !== false) {
    const hotTimer = scheduleDaily(Number(config.hotHour ?? 3), () => void runHotspot().catch(() => undefined))
    const weekTimer = scheduleWeekly(Number(config.weekDay ?? 1), Number(config.weekHour ?? 9), () =>
      void weekly().catch(() => undefined),
    )
    ctx.effect(() => () => {
      clearTimeout(hotTimer)
      clearTimeout(weekTimer)
    })
  }

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/memory/hotspot/run',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        res.status(200).send({ ok: true, ...(await runHotspot()) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/memory/hotspot',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const items = (await runs.find({}))
          .sort((a, b) => b.at - a.at)
          .slice(0, 20)
          .map((row) => ({
            id: row.id,
            at: new Date(row.at),
            scanned: row.scanned,
            status: row.status,
            changes: JSON.parse(row.changes_json) as Change[],
          }))
        res.status(200).send({ ok: true, items })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/memory/hotspot/rollback',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const ok = await rollback(id)
        res.status(ok ? 200 : 404).send(ok ? { ok: true } : { ok: false, error: '没有可回滚的批次' })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/memory/weekly/run',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const row = await weekly()
        res.status(200).send({ ok: true, week: row.week, markdown: row.markdown })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/memory/weekly',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const items = (await weeklies.find({}))
          .sort((a, b) => b.at - a.at)
          .slice(0, 12)
          .map((row) => ({ week: row.week, at: new Date(row.at), markdown: row.markdown }))
        res.status(200).send({ ok: true, items })
      },
    }),
  )
}

function scheduleDaily(hour: number, task: () => void): ReturnType<typeof setTimeout> {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  const timer = setTimeout(() => {
    task()
    scheduleDaily(hour, task)
  }, next.getTime() - now.getTime())
  timer.unref?.()
  return timer
}

function scheduleWeekly(day: number, hour: number, task: () => void): ReturnType<typeof setTimeout> {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0)
  const delta = (day - next.getDay() + 7) % 7
  next.setDate(next.getDate() + delta)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 7)
  const timer = setTimeout(() => {
    task()
    scheduleWeekly(day, hour, task)
  }, next.getTime() - now.getTime())
  timer.unref?.()
  return timer
}

function weekKey(date: Date): string {
  const start = new Date(date.getFullYear(), 0, 1)
  const week = Math.floor((date.getTime() - start.getTime()) / (7 * DAY))
  return `${date.getFullYear()}-W${week}`
}

export const defaultExport = { name, inject, apply }
