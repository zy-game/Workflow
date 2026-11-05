/**
 * @qingmei/qm-device —— 本机 harness 设备注册与任务队列。
 *
 * 设备上报平台/架构/可用 harness；青梅只把任务投递给目标设备，
 * 由设备侧 worker spawn 本机 dsh/zcode。服务端不假设客户端操作系统。
 */
import type { Context } from 'cordis'
import {
  uid,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type Row,
  type StoreService,
} from '@qingmei/core'

export interface DeviceConfig {
  /** 设备离线判定，默认 90 秒 */
  staleMs?: number
  /** 单设备保留的任务数，默认 200 */
  keepTasks?: number
}

export const name = 'qm-device'
export const inject = ['store', 'gateway']

const DEVICE_COLLECTION = 'qm_device'
const TASK_COLLECTION = 'qm_device_task'
const PLATFORMS = new Set(['windows', 'macos', 'linux', 'android', 'ios', 'unknown'])

interface DeviceRow extends Row {
  name: string
  platform: string
  arch: string
  hostname: string
  harnesses_json: string
  worker_version: string
  status: string
  last_seen: number
  created_at: number
}

interface DeviceTaskRow extends Row {
  device_id: string
  title: string
  prompt: string
  harness: string
  status: string
  progress_json: string
  result: string | null
  error: string | null
  created_at: number
  claimed_at: number | null
  finished_at: number | null
}

export interface HarnessCapability {
  kind: string
  acp: boolean
  mcp: boolean
  version?: string
}

export function normalizePlatform(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'win32' || text === 'win') return 'windows'
  if (text === 'darwin' || text === 'mac') return 'macos'
  if (PLATFORMS.has(text)) return text
  return 'unknown'
}

export function apply(ctx: Context, config: DeviceConfig = {}): void {
  const store = ctx.reflect.get('store', false) as StoreService | undefined
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!store) throw new Error('[qm-device] 缺少 store 服务')
  if (!gateway) throw new Error('[qm-device] 缺少 gateway 服务')
  const devices = store.collection<DeviceRow>(DEVICE_COLLECTION)
  const tasks = store.collection<DeviceTaskRow>(TASK_COLLECTION)
  const staleMs = Math.max(10_000, config.staleMs ?? 90_000)
  const keepTasks = Math.max(20, config.keepTasks ?? 200)
  let queue: Promise<unknown> = Promise.resolve()

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const toDevice = (row: DeviceRow) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    arch: row.arch,
    hostname: row.hostname,
    harnesses: JSON.parse(row.harnesses_json) as HarnessCapability[],
    workerVersion: row.worker_version,
    status: row.status,
    lastSeen: new Date(row.last_seen),
    createdAt: new Date(row.created_at),
    online: Date.now() - row.last_seen <= staleMs,
  })

  const toTask = (row: DeviceTaskRow) => ({
    id: row.id,
    deviceId: row.device_id,
    title: row.title,
    prompt: row.prompt,
    harness: row.harness,
    status: row.status,
    progress: JSON.parse(row.progress_json) as Record<string, unknown>[],
    result: row.result,
    error: row.error,
    createdAt: new Date(row.created_at),
    claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
  })

  async function upsert(input: {
    id?: string
    name?: string
    platform?: unknown
    arch?: unknown
    hostname?: unknown
    harnesses?: unknown
    workerVersion?: unknown
  }): Promise<DeviceRow> {
    const id = String(input.id ?? '').trim() || uid('dev')
    const existing = await devices.get(id)
    const now = Date.now()
    const harnesses = Array.isArray(input.harnesses)
      ? input.harnesses
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
          .map((item) => ({
            kind: String(item.kind ?? '').trim(),
            acp: item.acp === true,
            mcp: item.mcp === true,
            ...(typeof item.version === 'string' && item.version.trim() ? { version: item.version.trim() } : {}),
          }))
          .filter((item) => item.kind)
      : []
    const row: DeviceRow = {
      id,
      name: String(input.name ?? existing?.name ?? id).trim().slice(0, 100),
      platform: normalizePlatform(input.platform ?? existing?.platform),
      arch: String(input.arch ?? existing?.arch ?? process.arch).trim().slice(0, 40),
      hostname: String(input.hostname ?? existing?.hostname ?? '').trim().slice(0, 120),
      harnesses_json: JSON.stringify(harnesses),
      worker_version: String(input.workerVersion ?? existing?.worker_version ?? '').trim().slice(0, 40),
      status: 'online',
      last_seen: now,
      created_at: existing?.created_at ?? now,
    }
    if (existing) await devices.update(id, row)
    else await devices.insert(row)
    return row
  }

  async function enqueue(input: { deviceId?: unknown; prompt?: unknown; title?: unknown; harness?: unknown }) {
    const deviceId = String(input.deviceId ?? '').trim()
    const prompt = String(input.prompt ?? '').trim()
    if (!deviceId || !prompt) throw new Error('deviceId 和 prompt 必填')
    const device = await devices.get(deviceId)
    if (!device) throw new Error('没有这个设备')
    const now = Date.now()
    const task: DeviceTaskRow = {
      id: uid('dtask'),
      device_id: deviceId,
      title: String(input.title ?? prompt.slice(0, 40)).trim().slice(0, 120),
      prompt: prompt.slice(0, 20_000),
      harness: String(input.harness ?? 'dsh').trim() || 'dsh',
      status: 'queued',
      progress_json: '[]',
      result: null,
      error: null,
      created_at: now,
      claimed_at: null,
      finished_at: null,
    }
    await tasks.insert(task)
    const all = (await tasks.find({ where: { device_id: deviceId } })).sort((a, b) => b.created_at - a.created_at)
    for (const old of all.slice(keepTasks)) await tasks.delete(old.id)
    return task
  }

  async function claim(deviceId: string): Promise<DeviceTaskRow | null> {
    return serialize(async () => {
      const queued = (await tasks.find({ where: { device_id: deviceId, status: 'queued' } })).sort(
        (a, b) => a.created_at - b.created_at,
      )
      const task = queued[0]
      if (!task) return null
      await tasks.update(task.id, { status: 'running', claimed_at: Date.now() })
      const row = await tasks.get(task.id)
      return row ?? null
    })
  }

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/devices/register',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const device = await upsert((req.body ?? {}) as Record<string, unknown>)
        res.status(200).send({ ok: true, device: toDevice(device) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/devices/heartbeat',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = String(body.id ?? '').trim()
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const row = await devices.get(id)
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这个设备' })
          return
        }
        const device = await upsert({ id, ...body })
        res.status(200).send({ ok: true, device: toDevice(device) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/devices',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const items = (await devices.find({}))
          .sort((a, b) => b.last_seen - a.last_seen)
          .map(toDevice)
        res.status(200).send({ ok: true, items })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/devices/tasks',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        try {
          const task = await enqueue((req.body ?? {}) as Record<string, unknown>)
          res.status(201).send({ ok: true, task: toTask(task) })
        } catch (error) {
          res.status(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/devices/tasks',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : ''
        const rows = deviceId ? await tasks.find({ where: { device_id: deviceId } }) : await tasks.find({})
        const items = rows.sort((a, b) => b.created_at - a.created_at).slice(0, 100).map(toTask)
        res.status(200).send({ ok: true, items })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/devices/claim',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = String(body.deviceId ?? '').trim()
        if (!id) {
          res.status(400).send({ ok: false, error: 'deviceId 必填' })
          return
        }
        const task = await claim(id)
        res.status(200).send({ ok: true, task: task ? toTask(task) : null })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/devices/progress',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = String(body.taskId ?? '').trim()
        const row = id ? await tasks.get(id) : null
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这个任务' })
          return
        }
        const progress = JSON.parse(row.progress_json) as Record<string, unknown>[]
        progress.push({
          phase: String(body.phase ?? '').slice(0, 40),
          percent: Number.isFinite(Number(body.percent)) ? Number(body.percent) : null,
          note: String(body.note ?? '').slice(0, 500),
          at: Date.now(),
        })
        await tasks.update(id, { progress_json: JSON.stringify(progress.slice(-50)) })
        res.status(200).send({ ok: true })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/devices/finish',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = String(body.taskId ?? '').trim()
        const row = id ? await tasks.get(id) : null
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这个任务' })
          return
        }
        const status = body.status === 'failed' ? 'failed' : 'done'
        await tasks.update(id, {
          status,
          result: typeof body.result === 'string' ? body.result.slice(0, 20_000) : null,
          error: typeof body.error === 'string' ? body.error.slice(0, 2_000) : null,
          finished_at: Date.now(),
        })
        res.status(200).send({ ok: true })
      },
    }),
  )
}

export const defaultExport = { name, inject, apply }
