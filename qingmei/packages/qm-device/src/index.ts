/**
 * @qingmei/qm-device —— 本机 harness 设备注册与任务队列。
 *
 * 设备上报平台/架构/可用 harness；青梅只把任务投递给目标设备，
 * 由设备侧 worker spawn 本机 dsh/zcode。服务端不假设客户端操作系统。
 */
import { Service, type Context } from 'cordis'
import {
  EVENTS,
  uid,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type MemoryService,
  type Row,
  type StoreService,
  type TaskRun,
  TaskTargetService,
  type TaskTargetInput,
  type PreparedTaskTarget,
  taskViewOf,
  type TaskService,
  type TaskRunnerService,
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

export interface HarnessCapability {
  kind: string
  acp: boolean
  mcp: boolean
  transport?: string
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

class DeviceTaskTargets extends TaskTargetService {
  private readonly prepareFn: (input: TaskTargetInput) => Promise<PreparedTaskTarget>

  constructor(ctx: Context, prepareFn: (input: TaskTargetInput) => Promise<PreparedTaskTarget>) {
    super(ctx)
    this.prepareFn = prepareFn
  }

  prepare(input: TaskTargetInput): Promise<PreparedTaskTarget> {
    return this.prepareFn(input)
  }
}

export function apply(ctx: Context, config: DeviceConfig = {}): void {
  const store = ctx.store
  const gateway = ctx.gateway
  let memoryService: MemoryService | undefined
  ctx.inject(['memory'], (sub) => { memoryService = sub.memory })
  const devices = store.collection<DeviceRow>(DEVICE_COLLECTION)
  // 只读目录服务：聊天/规划按名字找工作区，不直接读 collection
  class DeviceDirectory extends Service {
    constructor(context: Context) {
      super(context, 'devices')
    }
    async list() {
      return (await devices.find({})).sort((a, b) => b.last_seen - a.last_seen).map(toDevice)
    }
  }
  new DeviceDirectory(ctx)
  let taskService: TaskService | undefined
  let taskRunner: TaskRunnerService | undefined
  ctx.inject(['task'], (sub) => { taskService = sub.task })
  ctx.inject(['taskRunner'], (sub) => { taskRunner = sub.taskRunner })
  new DeviceTaskTargets(ctx, prepareTarget)
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

  const executorIdOf = (deviceId: string) => `device:${deviceId}`

  const toTask = taskViewOf

  async function unifiedTasks(deviceId?: string): Promise<TaskRun[]> {
    if (!taskService) return []
    const runs = await taskService.list(200)
    if (deviceId) return runs.filter((run) => run.target.executorId === executorIdOf(deviceId))
    return runs.filter((run) => run.target.executorId.startsWith('device:'))
  }
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
            ...(typeof item.transport === 'string' && item.transport.trim() ? { transport: item.transport.trim() } : {}),
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

  async function prepareTarget(input: TaskTargetInput): Promise<PreparedTaskTarget> {
    const deviceId = input.executorId.startsWith('device:') ? input.executorId.slice('device:'.length) : ''
    if (!deviceId) throw new Error('只有 device:<id> 走设备执行器')
    const device = await devices.get(deviceId)
    if (!device) throw new Error('没有这个设备')
    const workspaces = JSON.parse(device.workspaces_json || '[]') as WorkspaceInfo[]
    const requestedWorkspace = String(input.workspaceId ?? '').trim()
    const workspace = requestedWorkspace ? workspaces.find((item) => item.id === requestedWorkspace) : undefined
    if (requestedWorkspace && !workspace) throw new Error('设备没有上报这个工作区')
    const cwd = String(input.cwd ?? workspace?.path ?? '').trim()
    const sessionKey = String(input.sessionKey ?? '').trim()
    let sessionId = String(input.sessionId ?? '').trim()
    if (!sessionId && sessionKey) {
      const previous = (await unifiedTasks(deviceId))
        .filter(
          (run) =>
            run.target.executorId === executorIdOf(deviceId) &&
            run.target.workspaceId === (workspace?.id ?? null) &&
            run.target.sessionKey === sessionKey &&
            run.sessionId,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
      sessionId = previous?.sessionId ?? ''
    }
    return {
      target: {
        executorId: executorIdOf(deviceId),
        ...(workspace?.id ? { workspaceId: workspace.id } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(cwd ? { cwd } : {}),
      },
      ...(sessionId ? { sessionId } : {}),
    }
  }

  async function claim(deviceId: string): Promise<TaskRun | null> {
    if (!taskRunner) return null
    return taskRunner.lease(executorIdOf(deviceId))
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
        const memory = memoryService
        if (!memory) {
          res.status(200).send({ ok: true, text: '', facts: [] })
          return
        }
        const deviceId = String(body.deviceId ?? '').trim()
        const sessionId = String(body.sessionId ?? '').trim()
        let contextText = text
        if (deviceId && sessionId) {
          const digest = await digests.get(`${deviceId}:${sessionId}`)
          if (digest) {
            const turns = JSON.parse(digest.turns_json || '[]') as Array<{ role?: string; text?: string }>
            const recent = turns
              .slice(-6)
              .map((turn) => `${turn.role ?? '?'}: ${String(turn.text ?? '').slice(0, 300)}`)
              .join('\n')
            contextText = [
              text,
              digest.summary ? `上一轮摘要：${digest.summary.slice(0, 2000)}` : '',
              recent ? `最近会话：\n${recent}` : '',
            ]
              .filter(Boolean)
              .join('\n\n')
          }
        }
        const result = await memory.recall({
          text: contextText.slice(0, 6000),
          limit: Number.isFinite(Number(body.limit)) ? Math.min(20, Math.max(1, Number(body.limit))) : 8,
        })
        res.status(200).send({ ok: true, text: result.text, facts: result.facts })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/memory/graph',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const focus = String(req.query.focus ?? '').trim()
        const kindFilter = String(req.query.kind ?? '').trim()
        const since = Number(req.query.since ?? 0) || 0
        const depth = Math.min(3, Math.max(1, Number(req.query.depth ?? 2) || 2))
        const limit = Math.min(500, Math.max(20, Number(req.query.limit ?? 200) || 200))
        const entities = (await store.collection('qm_entity').find({})) as unknown as Array<{
          id: string
          name: string
          kind: string
          aliases_json?: string
          valid_to?: number | null
        }>
        const edges = (await store.collection('qm_edge').find({})) as unknown as Array<{
          from_name: string
          to_name: string
          predicate: string
          kind: string
          weight: number
          last_seen: number
          valid_to?: number | null
        }>
        const usable = (name: string): boolean =>
          name.length >= 2 &&
          name.length <= 20 &&
          !/[\\\\/「」]/.test(name) &&
          !/^\\d+$/.test(name)
        const liveEdges = edges.filter((edge) => !edge.valid_to && (!since || edge.last_seen >= since))
        const liveEntities = entities.filter(
          (entity) => !entity.valid_to && usable(entity.name) && (!kindFilter || entity.kind === kindFilter),
        )
        const byName = new Map(liveEntities.map((entity) => [entity.name, entity]))
        let selected = liveEdges
        let nodeNames = new Set<string>()
        if (focus && byName.has(focus)) {
          nodeNames.add(focus)
          let frontier = new Set([focus])
          for (let step = 0; step < depth; step += 1) {
            const next = new Set<string>()
            for (const edge of liveEdges) {
              if (frontier.has(edge.from_name) && !nodeNames.has(edge.to_name)) next.add(edge.to_name)
              if (frontier.has(edge.to_name) && !nodeNames.has(edge.from_name)) next.add(edge.from_name)
            }
            for (const name of next) nodeNames.add(name)
            frontier = next
            if (next.size === 0) break
          }
          selected = liveEdges.filter((edge) => nodeNames.has(edge.from_name) || nodeNames.has(edge.to_name))
        } else {
          selected = [...liveEdges].sort((a, b) => b.weight - a.weight || b.last_seen - a.last_seen).slice(0, limit)
          for (const edge of selected) {
            nodeNames.add(edge.from_name)
            nodeNames.add(edge.to_name)
          }
        }
        const degree = new Map<string, number>()
        for (const edge of selected) {
          degree.set(edge.from_name, (degree.get(edge.from_name) ?? 0) + 1)
          degree.set(edge.to_name, (degree.get(edge.to_name) ?? 0) + 1)
        }
        const nodes = [...nodeNames]
          .filter((name) => byName.has(name))
          .map((name) => {
            const entity = byName.get(name)
            let aliases: string[] = []
            try {
              const parsed = JSON.parse(entity?.aliases_json ?? '[]')
              if (Array.isArray(parsed)) aliases = parsed.filter((item): item is string => typeof item === 'string')
            } catch {
              aliases = []
            }
            return {
              id: name,
              name,
              kind: entity?.kind ?? 'topic',
              aliases,
              degree: degree.get(name) ?? 0,
            }
          })
          .sort((a, b) => b.degree - a.degree)
          .slice(0, limit)
        const kept = new Set(nodes.map((node) => node.id))
        const graphEdges = selected
          .filter((edge) => kept.has(edge.from_name) && kept.has(edge.to_name))
          .slice(0, limit * 2)
          .map((edge) => ({
            from: edge.from_name,
            to: edge.to_name,
            predicate: edge.predicate,
            kind: edge.kind,
            weight: edge.weight,
            lastSeen: edge.last_seen,
          }))
        const facts = focus
          ? ((await store.collection('qm_mem_fact').find({})) as unknown as Array<{
              subject: string
              predicate: string
              object: string
              valid_to?: number | null
            }>)
              .filter((fact) => !fact.valid_to && (fact.subject === focus || fact.object === focus))
              .slice(0, 50)
              .map((fact) => ({ subject: fact.subject, predicate: fact.predicate, object: fact.object }))
          : []
        res.status(200).send({ ok: true, focus: focus || null, nodes, edges: graphEdges, facts })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/memory/vectors/backfill',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const memory = memoryService
        if (!memory) {
          res.status(503).send({ ok: false, error: 'no memory service' })
          return
        }
        const report = await memory.rebuildVectors()
        res.status(200).send({ ok: true, ...report })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/memory/recalls',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20))
        const rows = await store
          .collection<{ id: string; at: number; query: string; audience?: string; facts_json?: string }>('qm_recall_signal')
          .find({ order: [{ field: 'at', dir: 'desc' }], limit })
        const items = rows.map((row) => ({
          id: row.id,
          at: new Date(row.at),
          query: row.query,
          audience: row.audience ?? 'owner',
          facts: (() => {
            try {
              return JSON.parse(row.facts_json ?? '[]')
            } catch {
              return []
            }
          })(),
        }))
        res.status(200).send({ ok: true, items })
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
        // 会话收尾后广播：qm-distill 用它把手动会话（DSH GUI / ACP）里的陈述抽成记忆候选
        ctx.events.emit(EVENTS.sessionIngested, {
          deviceId,
          sessionId,
          summary: row.summary,
          turns: JSON.parse(row.turns_json) as { role?: string; text?: string }[],
          at: row.at,
        })
        res.status(200).send({ ok: true, id })
      },
    }),
  )
  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/devices/tasks',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : ''
        const rows = taskService ? await unifiedTasks(deviceId || undefined) : []
        const items = rows
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 100)
          .map(toTask)
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
        if (taskService) {
          const run = id ? await taskService.get(id) : null
          if (run) {
            await taskService.reportProgress(id, {
              phase: String(body.phase ?? '').slice(0, 40),
              ...(Number.isFinite(Number(body.percent)) ? { percent: Number(body.percent) } : {}),
              ...(typeof body.note === 'string' ? { note: body.note.slice(0, 500) } : {}),
            })
            res.status(200).send({ ok: true })
            return
          }
        }
        res.status(404).send({ ok: false, error: '没有这个任务' })
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
        if (taskService) {
          const run = id ? await taskService.get(id) : null
          if (run) {
            const status = body.status === 'failed' ? 'failed' : 'done'
            await taskService.finish(id, {
              status,
              ...(typeof body.sessionId === 'string' && body.sessionId.trim()
                ? { sessionId: body.sessionId.trim().slice(0, 120) }
                : {}),
              ...(typeof body.result === 'string' ? { result: body.result.slice(0, 20_000) } : {}),
              ...(typeof body.error === 'string' ? { error: body.error.slice(0, 2_000) } : {}),
            })
            res.status(200).send({ ok: true })
            return
          }
        }
        res.status(404).send({ ok: false, error: '没有这个任务' })
      },
    }),
  )
}

export const defaultExport = { name, inject, apply }










