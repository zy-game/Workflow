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
  type LlmService,
  type MemoryRecord,
  type MemoryService,
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

interface WorkspaceInfo {
  id: string
  title: string
  path: string
}

interface DeviceRow extends Row {
  name: string
  platform: string
  arch: string
  hostname: string
  harnesses_json: string
  workspaces_json: string
  worker_version: string
  status: string
  last_seen: number
  created_at: number
}

interface DigestRow extends Row {
  device_id: string
  session_id: string
  summary: string
  turns_json: string
  events_json: string
  facts_json: string
  lessons_json: string
  distilled_json: string
  at: number
}

interface DeviceTaskRow extends Row {
  device_id: string
  title: string
  prompt: string
  harness: string
  workspace_id: string | null
  cwd: string | null
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

export function deviceClassOf(platform: string): string {
  if (platform === 'android' || platform === 'ios') return 'mobile'
  if (platform === 'windows' || platform === 'macos' || platform === 'linux') return 'desktop'
  return 'unknown'
}

export function apply(ctx: Context, config: DeviceConfig = {}): void {
  const store = ctx.reflect.get('store', false) as StoreService | undefined
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!store) throw new Error('[qm-device] 缺少 store 服务')
  if (!gateway) throw new Error('[qm-device] 缺少 gateway 服务')
  const devices = store.collection<DeviceRow>(DEVICE_COLLECTION)
  const tasks = store.collection<DeviceTaskRow>(TASK_COLLECTION)
  const digests = store.collection<DigestRow>('qm_session_digest')
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
    systemType: row.platform,
    deviceClass: deviceClassOf(row.platform),
    harnesses: JSON.parse(row.harnesses_json) as HarnessCapability[],
    workspaces: JSON.parse(row.workspaces_json || '[]') as WorkspaceInfo[],
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
    workspaceId: row.workspace_id,
    cwd: row.cwd,
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
    workspaces?: unknown
    workerVersion?: unknown
  }): Promise<DeviceRow> {
    const id = String(input.id ?? '').trim() || uid('dev')
    const existing = await devices.get(id)
    const now = Date.now()
    const oldHarnesses = existing?.harnesses_json
      ? (JSON.parse(existing.harnesses_json) as HarnessCapability[])
      : []
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
      : oldHarnesses
    const oldWorkspaces = existing?.workspaces_json
      ? (JSON.parse(existing.workspaces_json) as WorkspaceInfo[])
      : []
    const workspaces = Array.isArray(input.workspaces)
      ? input.workspaces
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
          .map((item) => ({
            id: String(item.id ?? '').trim(),
            title: String(item.title ?? item.name ?? item.path ?? '').trim().slice(0, 120),
            path: String(item.path ?? '').trim(),
          }))
          .filter((item) => item.id && item.path)
      : oldWorkspaces
    const row: DeviceRow = {
      id,
      name: String(input.name ?? existing?.name ?? id).trim().slice(0, 100),
      platform: normalizePlatform(input.platform ?? existing?.platform),
      arch: String(input.arch ?? existing?.arch ?? process.arch).trim().slice(0, 40),
      hostname: String(input.hostname ?? existing?.hostname ?? '').trim().slice(0, 120),
      harnesses_json: JSON.stringify(harnesses),
      workspaces_json: JSON.stringify(workspaces),
      worker_version: String(input.workerVersion ?? existing?.worker_version ?? '').trim().slice(0, 40),
      status: 'online',
      last_seen: now,
      created_at: existing?.created_at ?? now,
    }
    if (existing) await devices.update(id, row)
    else await devices.insert(row)
    return row
  }

  async function enqueue(input: {
    deviceId?: unknown
    prompt?: unknown
    title?: unknown
    harness?: unknown
    workspaceId?: unknown
    cwd?: unknown
  }) {
    const deviceId = String(input.deviceId ?? '').trim()
    const prompt = String(input.prompt ?? '').trim()
    if (!deviceId || !prompt) throw new Error('deviceId 和 prompt 必填')
    const device = await devices.get(deviceId)
    if (!device) throw new Error('没有这个设备')
    const workspaces = JSON.parse(device.workspaces_json || '[]') as WorkspaceInfo[]
    const requestedWorkspace = String(input.workspaceId ?? '').trim()
    const workspace = requestedWorkspace ? workspaces.find((item) => item.id === requestedWorkspace) : undefined
    if (requestedWorkspace && !workspace) throw new Error('设备没有上报这个工作区')
    const cwd = String(input.cwd ?? workspace?.path ?? '').trim()
    const now = Date.now()
    const task: DeviceTaskRow = {
      id: uid('dtask'),
      device_id: deviceId,
      title: String(input.title ?? prompt.slice(0, 40)).trim().slice(0, 120),
      prompt: prompt.slice(0, 20_000),
      harness: String(input.harness ?? 'dsh').trim() || 'dsh',
      workspace_id: workspace?.id ?? null,
      cwd: cwd || null,
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

  async function claim(deviceId: string, harness = ''): Promise<DeviceTaskRow | null> {
    return serialize(async () => {
      const queued = (await tasks.find({ where: { device_id: deviceId, status: 'queued' } }))
        .filter((row) => !harness || row.harness === harness)
        .sort(
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

  async function distill(input: { summary: string; turns: unknown[]; facts: unknown[] }): Promise<MemoryRecord[]> {
    const llm = ctx.reflect.get('llm', false) as LlmService | undefined
    const memory = ctx.reflect.get('memory', false) as MemoryService | undefined
    if (!llm || !memory || input.facts.length > 0) return []
    const transcript = [input.summary, JSON.stringify(input.turns).slice(0, 4000)].join('\n').slice(0, 5000)
    if (transcript.trim().length < 10) return []
    const { text } = await llm.complete({
      messages: [
        {
          role: 'system',
          content:
            '你是一个知识提炼器。从会话记录中抽取值得长期记住的事实、决策和教训，只输出 JSON 数组。' +
            '元素形如 {"subject":"项目","predicate":"使用","object":"pnpm","confidence":0.9}；没有就输出 []。',
        },
        { role: 'user', content: transcript },
      ],
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim())
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    const records: MemoryRecord[] = []
    for (const item of parsed.slice(0, 8)) {
      if (!item || typeof item !== 'object') continue
      const value = item as Record<string, unknown>
      const subject = String(value.subject ?? '').trim()
      const predicate = String(value.predicate ?? '').trim()
      const object = String(value.object ?? '').trim()
      if (!subject || !predicate || !object) continue
      records.push({
        kind: 'fact',
        subject,
        predicate,
        object,
        confidence: Math.min(1, Math.max(0, Number(value.confidence) || 0.7)),
        sensitivity: 'private',
        origin: { kind: 'harness', id: 'device-worker' },
      })
    }
    if (records.length > 0) await memory.ingest(records)
    return records
  }
  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/devices/digests',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : ''
        const rows = deviceId ? await digests.find({ where: { device_id: deviceId } }) : await digests.find({})
        const items = rows
          .sort((a, b) => b.at - a.at)
          .slice(0, 100)
          .map((row) => ({
            id: row.id,
            deviceId: row.device_id,
            sessionId: row.session_id,
            summary: row.summary,
            turns: JSON.parse(row.turns_json || '[]'),
            events: JSON.parse(row.events_json || '[]'),
            facts: JSON.parse(row.facts_json || '[]'),
            lessons: JSON.parse(row.lessons_json || '[]'),
            at: new Date(row.at),
          }))
        res.status(200).send({ ok: true, items })
      },
    }),
  )
  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/devices/context',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const text = String(body.text ?? '').trim()
        if (!text) {
          res.status(400).send({ ok: false, error: 'text 必填' })
          return
        }
        const memory = ctx.reflect.get('memory', false) as MemoryService | undefined
        if (!memory) {
          res.status(200).send({ ok: true, text: '', facts: [] })
          return
        }
        const result = await memory.recall({
          text: text.slice(0, 2000),
          limit: Number.isFinite(Number(body.limit)) ? Math.min(20, Math.max(1, Number(body.limit))) : 8,
        })
        res.status(200).send({ ok: true, text: result.text, facts: result.facts })
      },
    }),
  )
  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/devices/ingest',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const deviceId = String(body.deviceId ?? '').trim()
        const sessionId = String(body.sessionId ?? '').trim()
        if (!deviceId || !sessionId) {
          res.status(400).send({ ok: false, error: 'deviceId 和 sessionId 必填' })
          return
        }
        const id = `${deviceId}:${sessionId}`
        const existing = await digests.get(id)
        const row: DigestRow = {
          id,
          device_id: deviceId,
          session_id: sessionId,
          summary: String(body.summary ?? '').slice(0, 20_000),
          turns_json: JSON.stringify(Array.isArray(body.turns) ? body.turns.slice(-200) : []),
          events_json: JSON.stringify(Array.isArray(body.events) ? body.events.slice(-100) : []),
          facts_json: JSON.stringify(Array.isArray(body.facts) ? body.facts.slice(0, 50) : []),
          lessons_json: JSON.stringify(Array.isArray(body.lessons) ? body.lessons.slice(0, 50) : []),
          distilled_json: existing?.distilled_json ?? '[]',
          at: Date.now(),
        }
        if (existing) await digests.update(id, row)
        else await digests.insert(row)
        let distilled: MemoryRecord[] = []
        try {
          distilled = await distill({
            summary: row.summary,
            turns: JSON.parse(row.turns_json) as unknown[],
            facts: JSON.parse(row.facts_json) as unknown[],
          })
        } catch {
          distilled = []
        }
        if (distilled.length > 0) {
          await digests.update(id, { distilled_json: JSON.stringify(distilled) })
        }
        res.status(200).send({ ok: true, id, distilled: distilled.length })
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
        const harness = String(body.harness ?? '').trim()
        const task = await claim(id, harness)
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
