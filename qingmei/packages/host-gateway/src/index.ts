/**
 * @qingmei/host-gateway —— 用 node:http 承载网关服务。
 *
 * 职责边界：只做传输（静态文件、鉴权、SSE、JSON），
 * 业务路由与事件广播仍然在 gateway 服务里。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { Context } from 'cordis'
import {
  EVENTS,
  InvalidScheduleError,
  listenerCount,
  uid,
  type ChannelService,
  type GatewayEvent,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type InboundMessage,
  type MemoryService,
  type HistoryService,
  type MemoryQueueService,
  type PersonaService,
  type Row,
  type SchedulePatch,
  type ScheduleService,
  type StoreService,
} from '@qingmei/core'
import type { GatewayHub } from '@qingmei/service-gateway'

declare module 'cordis' {
  interface Context {
    gateway: GatewayService
  }
  interface Events {
    'qm/inbound'(message: InboundMessage): void
  }
}

export interface Config {
  /** 监听地址，默认 127.0.0.1 */
  host?: string
  /** 监听端口，默认 7410；测试传 0 由系统分配 */
  port?: number
  /** Bearer token，/api/v1/* 的准入凭证，必填 */
  token?: string
  /** 前端静态产物目录，默认 ./apps/web/public（相对进程工作目录） */
  webRoot?: string
  /** 图片上传目录，默认 ./data/uploads（相对进程工作目录） */
  uploadDir?: string
  /** 管理员账号；默认 admin */
  adminUser?: string
  /** 管理员密码；为空时退回 token */
  adminPassword?: string
  /** 会话签名密钥；默认用 token */
  sessionSecret?: string
}

export interface ServerInfo {
  host: string
  port: number
  url: string
}

interface Options {
  host: string
  port: number
  token: string
  webRoot: string
  uploadDir: string
  adminUser: string
  adminPassword: string
  sessionSecret: string
}

interface ResourceServices {
  store?: StoreService
  persona?: PersonaService
  memory?: MemoryService
  memoryQueue?: MemoryQueueService
  schedule?: ScheduleService
  channel?: ChannelService
  history?: HistoryService
}

interface HandlerDeps {
  resources: ResourceServices
  ctx: Context
  gateway: GatewayHub
  options: Options
  clients: Set<ServerResponse>
  startedAt: number
}

const HEARTBEAT_MS = 15_000
const MAX_BODY_BYTES = 1_048_576
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
}

const serverInfo = new WeakMap<Context, ServerInfo>()

/** 查询本进程里 host-gateway 实际监听的地址（port 0 时用来发现随机端口） */
export function getServerInfo(ctx: Context): ServerInfo | undefined {
  return serverInfo.get(ctx) ?? serverInfo.get(ctx[Context.root])
}

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

function normalizeConfig(config: Config): Options {
  const token = typeof config.token === 'string' ? config.token : ''
  if (token.trim() === '') throw new Error('host-gateway: config.token 必须是非空字符串')
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? 7410
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`host-gateway: config.port 必须是 0..65535 的整数，收到 ${String(config.port)}`)
  }
  return {
    host,
    port,
    token,
    webRoot: path.resolve(config.webRoot ?? 'apps/web/public'),
    uploadDir: path.resolve(config.uploadDir ?? 'data/uploads'),
    adminUser: config.adminUser?.trim() || 'admin',
    adminPassword: config.adminPassword ?? '',
    sessionSecret: config.sessionSecret ?? token,
  }
}

function assertGateway(gateway: GatewayHub): void {
  for (const method of ['subscribe', 'match', 'dispatch'] as const) {
    if (typeof gateway[method] !== 'function') {
      throw new TypeError(`host-gateway 需要 GatewayHub 提供的 ${method}()；请先加载 @qingmei/service-gateway`)
    }
  }
}

// 必须是箭头函数：普通函数带 prototype，会被 cordis 当成构造器用 new 调用，
// 这样 apply 返回的监听 Promise 会被丢弃（fiber 提前进入 ACTIVE）。
export const apply = (ctx: Context, config: Config = {}): Promise<void> => {
  const options = normalizeConfig(config)
  const gateway = ctx.get('gateway') as GatewayHub | undefined
  if (!gateway) {
    throw new Error('host-gateway 缺少必需服务 "gateway"：请先加载 @qingmei/service-gateway')
  }
  assertGateway(gateway)
  mkdirSync(options.uploadDir, { recursive: true })

  const startedAt = Date.now()
  const clients = new Set<ServerResponse>()
  const resources: ResourceServices = {}
  ctx.inject(['store'], (sub) => { resources.store = sub.store })
  ctx.inject(['history'], (sub) => { resources.history = sub.history })
  ctx.inject(['persona'], (sub) => { resources.persona = sub.persona })
  ctx.inject(['memory'], (sub) => { resources.memory = sub.memory })
  ctx.inject(['memoryQueue'], (sub) => { resources.memoryQueue = sub.memoryQueue })
  ctx.inject(['schedule'], (sub) => { resources.schedule = sub.schedule })
  ctx.inject(['channel'], (sub) => { resources.channel = sub.channel })
  const deps: HandlerDeps = { resources, ctx, gateway, options, clients, startedAt }
  const server = createServer((req, res) => {
    void handleRequest(deps, req, res)
  })

  const unsubscribe = gateway.subscribe((event) => {
    const frame = formatEvent(event)
    for (const client of clients) {
      try {
        client.write(frame)
      } catch {
        clients.delete(client)
      }
    }
  })

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(': ping\n\n')
      } catch {
        clients.delete(client)
      }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()

  const shutdown = async (): Promise<void> => {
    clearInterval(heartbeat)
    unsubscribe()
    for (const client of clients) {
      try {
        client.end()
      } catch {
        // 连接已经由对端关闭，无需处理。
      }
    }
    clients.clear()
    serverInfo.delete(ctx)
    serverInfo.delete(ctx[Context.root])
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  ctx.effect(() => () => shutdown())

  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : options.port
      const info: ServerInfo = {
        host: options.host,
        port,
        url: `http://${options.host}:${port}`,
      }
      serverInfo.set(ctx, info)
      serverInfo.set(ctx[Context.root], info)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.port, options.host)
  })
}

async function handleRequest(
  deps: HandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await routeRequest(deps, req, res)
  } catch (error) {
    fail(res, error)
  }
}

async function routeRequest(
  deps: HandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-QM-Client')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS')
  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (pathname === '/healthz') {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed')
    const consumers = listenerCount(deps.ctx, EVENTS.inbound)
    const payload = {
      // 没有入站消费者时健康检查必须为 false：否则消息会被静默丢弃。
      ok: consumers !== 0,
      uptime: Math.floor((Date.now() - deps.startedAt) / 1000),
      agent: consumers,
      channels: channelStatus(deps.resources.channel),
    }
    if (method === 'HEAD') {
      const body = JSON.stringify(payload)
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end()
      return
    }
    sendJson(res, 200, payload)
    return
  }

  if (pathname === '/api/v1/login' && method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>
    const user = (typeof body.user === 'string' ? body.user.trim() : '').toLowerCase()
    const password = (typeof body.password === 'string' ? body.password : '').trim()
    const expectedUser = deps.options.adminUser.trim().toLowerCase()
    const passwords = [deps.options.adminPassword, deps.options.token]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    const passwordOk = passwords.some((expected) => safeEqual(password, expected))
    if (user !== expectedUser || !passwordOk) {
      sendJson(res, 401, { ok: false, error: '账号或密码不对' })
      return
    }
    const cookie = sessionCookie(deps.options, user, req)
    res.setHeader('Set-Cookie', cookie)
    const wantsToken = req.headers['x-qm-client'] === 'mobile'
    sendJson(res, 200, { ok: true, user, ...(wantsToken ? { token: deps.options.token } : {}) })
    return
  }

  if (pathname === '/api/v1/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', 'qm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
    sendJson(res, 200, { ok: true })
    return
  }

  if (pathname === '/api/v1/session' && method === 'GET') {
    const user = sessionUser(req, deps.options)
    sendJson(res, user ? 200 : 401, user ? { ok: true, user } : { ok: false, error: 'unauthorized' })
    return
  }

  if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
    if (!authorized(req, url, deps.options)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    if (pathname === '/api/v1/uploads' && method === 'POST') {
      await receiveUpload(deps, req, res)
      return
    }
    if (pathname.startsWith('/api/v1/uploads/') && method === 'GET') {
      await serveUpload(deps, res, pathname)
      return
    }
    if (pathname === '/api/v1/events' && method === 'GET') {
      openEventStream(deps, req, res)
      return
    }
    if (pathname === '/api/v1/messages' && method === 'POST') {
      // 没有消费者时立刻 503，而不是收下消息后石沉大海。
      if (listenerCount(deps.ctx, EVENTS.inbound) === 0) {
        sendJson(res, 503, { ok: false, error: 'no agent: 没有插件消费 qm/inbound' })
        return
      }
      await receiveMessage(deps, req, res)
      return
    }
    if (pathname === '/api/v1/messages' && method === 'GET') {
      const conversationId = url.searchParams.get('conversationId') ?? undefined
      const limit = parseLimit(url.searchParams.get('limit'))
      sendJson(res, 200, await readHistory(deps.ctx, deps.resources.history, conversationId, limit))
      return
    }
    if (pathname === '/api/v1/memory/queue' && method === 'GET') {
      const memoryQueue = deps.resources.memoryQueue
      if (!memoryQueue) {
        sendJson(res, 200, { count: 0, items: [] })
        return
      }
      const items = await memoryQueue.pending()
      sendJson(res, 200, { count: items.length, items })
      return
    }
    if (pathname === '/api/v1/persona' && (method === 'GET' || method === 'POST')) {
      const persona = deps.resources.persona
      if (!persona) {
        sendJson(res, 503, { ok: false, error: 'no persona service' })
        return
      }
      const snapshot = method === 'POST' ? await persona.reload() : persona.current()
      sendJson(res, 200, { persona: snapshot })
      return
    }    if (pathname === '/api/v1/memory/stats' && method === 'GET') {
      const memory = deps.resources.memory
      if (!memory) {
        sendJson(res, 503, { ok: false, error: 'no memory service' })
        return
      }
      sendJson(res, 200, { ok: true, stats: await memory.stats() })
      return
    }

    if (pathname === '/api/v1/memory/concepts/proposals' && method === 'GET') {
      const memory = deps.resources.memory
      if (!memory) {
        sendJson(res, 503, { ok: false, error: 'no memory service' })
        return
      }
      sendJson(res, 200, { ok: true, proposals: await memory.conceptProposals() })
      return
    }

    if (pathname === '/api/v1/memory/concepts/changes' && method === 'GET') {
      const memory = deps.resources.memory
      if (!memory) {
        sendJson(res, 503, { ok: false, error: 'no memory service' })
        return
      }
      sendJson(res, 200, { ok: true, changes: await memory.conceptChanges(50) })
      return
    }

    if (pathname === '/api/v1/memory/consolidate' && method === 'POST') {
      const memory = deps.resources.memory
      if (!memory) {
        sendJson(res, 503, { ok: false, error: 'no memory service' })
        return
      }
      sendJson(res, 200, { ok: true, report: await memory.consolidate() })
      return
    }

    if (pathname === '/api/v1/memory/facts' && method === 'GET') {
      const memory = deps.resources.memory
      if (!memory) {
        sendJson(res, 503, { ok: false, error: 'no memory service' })
        return
      }
      const facts = await memory.listFacts({ limit: parseLimit(url.searchParams.get('limit')) })
      sendJson(res, 200, { facts })
      return
    }
    if (pathname === '/api/v1/memory/profile' && method === 'GET') {
      const memory = deps.resources.memory
      if (!memory) {
        sendJson(res, 503, { ok: false, error: 'no memory service' })
        return
      }
      const entries = await memory.profile({ audience: 'owner' })
      sendJson(res, 200, { entries })
      return
    }
    if (pathname === '/api/v1/memory/summary' && method === 'GET') {
      const memory = deps.resources.memory
      if (!memory) {
        sendJson(res, 503, { ok: false, error: 'no memory service' })
        return
      }
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (!sessionId) throw new HttpError(400, 'sessionId 必填')
      sendJson(res, 200, { summary: await memory.summarize(sessionId) })
      return
    }
    if (pathname.startsWith('/api/v1/memory/facts/') && (method === 'PATCH' || method === 'DELETE')) {
      const memory = deps.resources.memory
      if (!memory) {
        sendJson(res, 503, { ok: false, error: 'no memory service' })
        return
      }
      const id = decodeURIComponent(pathname.slice('/api/v1/memory/facts/'.length))
      if (!id) throw new HttpError(400, 'id 必填')
      const audit = deps.ctx.get('audit', false) as
        | { append: (entry: Record<string, unknown>) => Promise<void> }
        | undefined
      if (method === 'DELETE') {
        const deleted = await memory.forget([id])
        // 记忆的删除是纠错行为，要能查：谁在什么时候删了哪条
        void audit
          ?.append({
            at: new Date(),
            actorId: 'owner',
            channel: 'web',
            action: 'memory.fact.delete',
            target: id,
            decision: 'allow',
            detail: { deleted },
            traceId: `mem_${Date.now().toString(36)}`,
          })
          .catch(() => undefined)
        sendJson(res, 200, { ok: true, deleted })
        return
      }
      const body = await readJsonBody(req)
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError(400, '请求体必须是 JSON 对象')
      }
      const record = body as Record<string, unknown>
      const updated = await memory.updateFact(id, {
        ...(typeof record.object === 'string' ? { object: record.object } : {}),
        ...(typeof record.confidence === 'number' ? { confidence: record.confidence } : {}),
        ...(typeof record.salience === 'number' ? { salience: record.salience } : {}),
      })
      if (!updated) throw new HttpError(404, '事实不存在或没有可更新字段')
      void audit
        ?.append({
          at: new Date(),
          actorId: 'owner',
          channel: 'web',
          action: 'memory.fact.update',
          target: id,
          decision: 'allow',
          detail: typeof record.object === 'string' ? { object: record.object } : {},
          traceId: `mem_${Date.now().toString(36)}`,
        })
        .catch(() => undefined)
      sendJson(res, 200, { ok: true })
      return
    }    if (pathname === '/api/v1/memory' && method === 'GET') {
      const memory = deps.resources.memory
      if (!memory) {
        sendJson(res, 503, { ok: false, error: 'no memory service' })
        return
      }
      const query = url.searchParams.get('q') ?? ''
      const result = await memory.recall({
        text: query,
        limit: parseLimit(url.searchParams.get('limit')) ?? undefined,
      })
      sendJson(res, 200, { facts: result.facts, text: result.text })
      return
    }
    if (pathname === '/api/v1/schedules' && method === 'GET') {
      const schedule = deps.resources.schedule
      if (!schedule) {
        sendJson(res, 503, { ok: false, error: 'no schedule service' })
        return
      }
      // Scheduled 里的 Date 直接由 JSON.stringify 序列化成 ISO 字符串
      sendJson(res, 200, { ok: true, items: await schedule.list() })
      return
    }
    if (pathname.startsWith('/api/v1/schedules/') && method === 'DELETE') {
      const schedule = deps.resources.schedule
      if (!schedule) {
        sendJson(res, 503, { ok: false, error: 'no schedule service' })
        return
      }
      const id = scheduleIdOf(pathname)
      if (!id) throw new HttpError(400, '缺少提醒 id')
      if (!(await schedule.cancel(id))) {
        sendJson(res, 404, { ok: false, error: '没有找到这条提醒' })
        return
      }
      sendJson(res, 200, { ok: true, cancelled: true })
      return
    }
    if (pathname.startsWith('/api/v1/schedules/') && method === 'PATCH') {
      const schedule = deps.resources.schedule
      if (!schedule) {
        sendJson(res, 503, { ok: false, error: 'no schedule service' })
        return
      }
      const id = scheduleIdOf(pathname)
      if (!id) throw new HttpError(400, '缺少提醒 id')
      const body = await readJsonBody(req)
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError(400, '请求体必须是 JSON 对象')
      }
      let item: Awaited<ReturnType<ScheduleService['update']>>
      try {
        item = await schedule.update(id, schedulePatchFrom(body as Record<string, unknown>))
      } catch (error) {
        // 参数问题（cron 写错、规则冲突）是 400，不是 500
        if (error instanceof InvalidScheduleError) throw new HttpError(400, error.message)
        throw error
      }
      if (!item) {
        sendJson(res, 404, { ok: false, error: '这条提醒不存在或已经结束' })
        return
      }
      sendJson(res, 200, { ok: true, item })
      return
    }
    if (method === 'POST') {
      const action = scheduleActionOf(pathname)
      if (action) {
        const schedule = deps.resources.schedule
        if (!schedule) {
          sendJson(res, 503, { ok: false, error: 'no schedule service' })
          return
        }
        const ok =
          action.action === 'pause' ? await schedule.pause(action.id) : await schedule.resume(action.id)
        if (!ok) {
          sendJson(res, 404, { ok: false, error: '这条提醒不存在或已经结束' })
          return
        }
        sendJson(res, 200, { ok: true, state: action.action === 'pause' ? 'paused' : 'active' })
        return
      }
    }

    if (pathname.startsWith('/api/v1/memory/concepts/') && method === 'POST') {
      const memory = deps.resources.memory
      if (!memory) {
        sendJson(res, 503, { ok: false, error: 'no memory service' })
        return
      }
      const body = await readJsonBody(req).catch(() => ({}))
      const proposal = parseBodyRecord(body)
      if (pathname === '/api/v1/memory/concepts/evaluate') {
        const evaluation = await memory.evaluateConceptChange(proposal as never)
        sendJson(res, evaluation ? 200 : 400, evaluation ? { ok: true, evaluation } : { ok: false, error: '提案无效或不可评估' })
        return
      }
      if (pathname === '/api/v1/memory/concepts/apply') {
        const result = await memory.applyConceptChange(proposal as never)
        sendJson(res, result ? 200 : 400, result ? { ok: true, ...result } : { ok: false, error: '提案无效或不可应用' })
        return
      }
      if (pathname === '/api/v1/memory/concepts/rollback-batch') {
        const ids = Array.isArray(proposal.changeIds) ? proposal.changeIds.map(String) : []
        const result = ids.length > 0 ? await memory.rollbackConceptChanges(ids) : { rolled: 0 }
        sendJson(res, result.rolled > 0 ? 200 : 400, result.rolled > 0 ? { ok: true, ...result } : { ok: false, error: '没有可回滚的变更' })
        return
      }
      if (pathname === '/api/v1/memory/concepts/rollback') {
        const changeId = typeof proposal.changeId === 'string' ? proposal.changeId : ''
        const rolled = changeId ? await memory.rollbackConceptChange(changeId) : false
        sendJson(res, rolled ? 200 : 400, rolled ? { ok: true } : { ok: false, error: '变更不存在或不可回滚' })
        return
      }
    }

    await dispatchGatewayRoute(deps, req, res, url, method)
    return
  }

  if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed')
  await serveStatic(res, deps.options.webRoot, pathname, method === 'HEAD')
}

function channelStatus(channel: ChannelService | undefined): { id: string; online: boolean }[] {
  if (!channel) return []
  try {
    return channel.status()
  } catch {
    return []
  }
}

function bearerOf(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1] : undefined
}

/**
 * 常规接口走 Authorization: Bearer；SSE 例外：
 * 浏览器的 EventSource 不能设置自定义 header，只能把令牌放在 query 里。
 */
function authorized(req: IncomingMessage, url: URL, options: Options): boolean {
  const headerToken = bearerOf(req.headers.authorization)
  if (headerToken !== undefined) return tokenMatches(headerToken, options.token)
  if (sessionUser(req, options)) return true
  if (req.method === 'GET' && (url.pathname === '/api/v1/events' || url.pathname.startsWith('/api/v1/uploads/'))) {
    return tokenMatches(url.searchParams.get('token') ?? undefined, options.token)
  }
  return false
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function signSession(options: Options, user: string, expires: number): string {
  const payload = `${user}.${expires}`
  const signature = createHmac('sha256', options.sessionSecret).update(payload).digest('base64url')
  return `${Buffer.from(payload).toString('base64url')}.${signature}`
}

function sessionUser(req: IncomingMessage, options: Options): string | null {
  const cookie = req.headers.cookie ?? ''
  const match = /(?:^|;\s*)qm_session=([^;]+)/.exec(cookie)
  if (!match) return null
  const [encoded, signature] = match[1].split('.')
  if (!encoded || !signature) return null
  let payload: string
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const expected = createHmac('sha256', options.sessionSecret).update(payload).digest('base64url')
  if (!safeEqual(signature, expected)) return null
  const [user, expiresText] = payload.split('.')
  if (!user || !expiresText) return null
  if (Number(expiresText) < Date.now()) return null
  return user
}

function sessionCookie(options: Options, user: string, req: IncomingMessage): string {
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000
  const secure =
    Boolean((req.socket as { encrypted?: boolean }).encrypted) ||
    String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
  return `qm_session=${signSession(options, user, expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`
}

function tokenMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function openEventStream(deps: HandlerDeps, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 3000\n\n')
  res.write('event: ready\ndata: {"ok":true}\n\n')
  deps.clients.add(res)
  res.on('close', () => {
    deps.clients.delete(res)
  })
}

function formatEvent(event: GatewayEvent): string {
  const type = String(event.type).replace(/[\r\n]/g, '')
  const data = JSON.stringify(event.data === undefined ? null : event.data)
  return `event: ${type}\ndata: ${data}\n\n`
}

const IMAGE_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

async function receiveUpload(
  deps: HandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req, 6 * 1024 * 1024)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  const record = body as Record<string, unknown>
  const mime = String(record.mime ?? '')
  const ext = IMAGE_MIME[mime]
  if (!ext) throw new HttpError(400, '只支持 png/jpeg/webp/gif 图片')
  let data = String(record.data ?? '')
  if (data.startsWith('data:')) {
    const comma = data.indexOf(',')
    if (comma < 0) throw new HttpError(400, 'data URL 格式不合法')
    data = data.slice(comma + 1)
  }
  const buffer = Buffer.from(data, 'base64')
  if (buffer.length === 0) throw new HttpError(400, '图片内容为空')
  if (buffer.length > 4 * 1024 * 1024) throw new HttpError(413, '单张图片不能超过 4MB')
  const filename = `${randomUUID()}.${ext}`
  await writeFile(path.join(deps.options.uploadDir, filename), buffer)
  sendJson(res, 200, { ok: true, url: `/api/v1/uploads/${filename}`, mime })
}

async function serveUpload(deps: HandlerDeps, res: ServerResponse, pathname: string): Promise<void> {
  const filename = decodeURIComponent(pathname.slice('/api/v1/uploads/'.length))
  if (!/^[a-f0-9-]+\.(png|jpg|jpeg|webp|gif)$/i.test(filename)) {
    throw new HttpError(400, '非法文件名')
  }
  const target = path.join(deps.options.uploadDir, filename)
  if (!target.startsWith(deps.options.uploadDir + path.sep)) throw new HttpError(400, '非法路径')
  const data = await readFile(target).catch((error: unknown) => {
    if (isNotFound(error)) throw new HttpError(404, 'not found')
    throw error
  })
  const ext = path.extname(filename).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=86400',
  })
  res.end(data)
}
async function receiveMessage(
  deps: HandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  const record = body as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  const rawImages = Array.isArray(record.images) ? record.images.map(String) : []
  if (rawImages.length > 4) throw new HttpError(400, '一次最多 4 张图片')
  const images = rawImages.filter((url) =>
    /^\/api\/v1\/uploads\/[a-f0-9-]+\.(png|jpe?g|webp|gif)$/i.test(url),
  )
  if (images.length !== rawImages.length) throw new HttpError(400, '图片地址不合法')
  if (!text && images.length === 0) throw new HttpError(400, 'text 和 images 至少有一个')
  const rawConversationId = record.conversationId
  if (rawConversationId !== undefined && typeof rawConversationId !== 'string') {
    throw new HttpError(400, 'conversationId 必须是字符串')
  }
  const conversationId =
    typeof rawConversationId === 'string' && rawConversationId.trim() !== '' ? rawConversationId : 'owner'
  const deviceId = typeof record.deviceId === 'string' ? record.deviceId.trim().slice(0, 40) : undefined

  const message: InboundMessage = {
    platformMessageId: uid('msg'),
    channel: 'web',
    accountId: 'web',
    conversation: { kind: 'dm', id: conversationId },
    sender: { platformUserId: 'owner', displayName: '我' },
    ...(deviceId ? { deviceId } : {}),
    blocks: [
      ...images.map((url) => ({ type: 'image' as const, url })),
      { type: 'text' as const, text: text || '[图片]' },
    ],
    receivedAt: new Date(),
  }

  try {
    deps.ctx.emit('qm/inbound', message)
  } catch (error) {
    // 入站事件已被接收，下游处理失败不应让客户端重投同一条消息。
    deps.ctx.logger.warn('qm/inbound 处理失败:', error)
  }

  sendJson(res, 200, { ok: true, platformMessageId: message.platformMessageId })
}

interface MessageRow extends Row {
  session_id?: string
  sessionId?: string
  conversationId?: string
  conversation_id?: string
  created_at?: string | number | Date
  createdAt?: string | number | Date
  [key: string]: unknown
}

async function readHistory(
  ctx: Context,
  history: HistoryService | undefined,
  conversationId: string | undefined,
  limit: number,
): Promise<MessageRow[]> {
  if (!history) return []
  try {
    return (await history.recent(conversationId ?? 'owner', limit)) as unknown as MessageRow[]
  } catch (error) {
    ctx.logger.warn('读取历史失败，按空历史返回:', error)
    return []
  }
}

/** qm-agent 的 session id 是 `s_<conversation.id>`；同时兼容直接存 conversationId 的实现。 */
function belongsToConversation(row: MessageRow, conversationId: string): boolean {
  const values = [row.session_id, row.sessionId, row.conversationId, row.conversation_id]
  return values.some((value) => value === conversationId || value === `s_${conversationId}`)
}

function createdAtOf(row: MessageRow): number {
  const value = row.created_at ?? row.createdAt
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_LIMIT
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, value))
}

/** 从 /api/v1/schedules/<id> 取 id；空串或非法百分号编码返回 null */
function scheduleIdOf(pathname: string): string | null {
  const raw = pathname.slice('/api/v1/schedules/'.length)
  if (raw === '') return null
  try {
    return decodeURIComponent(raw).trim() || null
  } catch {
    return null
  }
}

/** 识别 /api/v1/schedules/<id>/pause|resume */
function scheduleActionOf(pathname: string): { id: string; action: 'pause' | 'resume' } | null {
  const prefix = '/api/v1/schedules/'
  if (!pathname.startsWith(prefix)) return null
  const match = /^(.+)\/(pause|resume)$/.exec(pathname.slice(prefix.length))
  if (!match) return null
  let id: string
  try {
    id = decodeURIComponent(match[1]!).trim()
  } catch {
    return null
  }
  if (!id) return null
  return { id, action: match[2] as 'pause' | 'resume' }
}

/**
 * 把 PATCH 请求体折成 SchedulePatch。
 *
 * 只接受显式给出的字段；一个字段都没有视为无效请求，避免「静默什么都没改」。
 */
function conceptProposalFrom(req: GatewayRequest): Record<string, unknown> {
  const body = parseBodyRecord(req.body)
  if (Object.keys(body).length > 0) return body
  const raw = typeof req.query.proposal === 'string' ? req.query.proposal : ''
  if (!raw) return {}
  try {
    return parseBodyRecord(JSON.parse(raw))
  } catch {
    return {}
  }
}

function parseBodyRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function schedulePatchFrom(body: Record<string, unknown>): SchedulePatch {
  const patch: SchedulePatch = {}
  if (typeof body.text === 'string') patch.text = body.text
  if (typeof body.cron === 'string' && body.cron.trim()) patch.cron = body.cron.trim()
  if (typeof body.timezone === 'string' && body.timezone.trim()) patch.timezone = body.timezone.trim()
  if (typeof body.at === 'string') {
    const parsed = Date.parse(body.at)
    if (!Number.isFinite(parsed)) throw new HttpError(400, 'at 不是有效时间')
    patch.at = new Date(parsed)
  }
  if (typeof body.everyMs === 'number') patch.everyMs = body.everyMs
  if (body.missedPolicy === 'skip' || body.missedPolicy === 'fire-once') {
    patch.missedPolicy = body.missedPolicy
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, '没有可修改的字段')
  return patch
}

async function dispatchGatewayRoute(
  deps: HandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<void> {
  if (!deps.gateway.match(method, url.pathname)) throw new HttpError(404, 'not found')
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readJsonBody(req)
  const request: GatewayRequest = {
    method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body,
  }
  const handled = await deps.gateway.dispatch(request, toGatewayResponse(res))
  if (!handled) throw new HttpError(404, 'not found')
  if (!res.writableEnded) {
    if (!res.headersSent) res.writeHead(204)
    res.end()
  }
}

function toGatewayResponse(res: ServerResponse): GatewayResponse {
  let statusCode = 200
  const headers = new Map<string, string>()
  const response: GatewayResponse = {
    status(code) {
      statusCode = code
      return response
    },
    header(name, value) {
      headers.set(name, value)
      return response
    },
    send(body) {
      if (res.writableEnded) return
      const isJson = typeof body === 'object' && !(body instanceof Uint8Array)
      if (!headers.has('Content-Type')) {
        if (isJson) headers.set('Content-Type', 'application/json; charset=utf-8')
        else if (body instanceof Uint8Array) headers.set('Content-Type', 'application/octet-stream')
        else headers.set('Content-Type', 'text/plain; charset=utf-8')
      }
      const payload = isJson ? (JSON.stringify(body) ?? 'null') : body
      res.writeHead(statusCode, Object.fromEntries(headers))
      res.end(payload)
    },
  }
  return response
}

async function serveStatic(
  res: ServerResponse,
  webRoot: string,
  pathname: string,
  headOnly: boolean,
): Promise<void> {
  const target = resolveStaticPath(webRoot, pathname)
  if (!target) throw new HttpError(400, '非法路径')
  const info = await stat(target).catch((error: unknown) => {
    if (isNotFound(error)) throw new HttpError(404, 'not found')
    throw error
  })
  const file = info.isDirectory() ? path.join(target, 'index.html') : target
  const data = await readFile(file).catch((error: unknown) => {
    if (isNotFound(error)) throw new HttpError(404, 'not found')
    throw error
  })
  res.writeHead(200, {
    'Content-Type': mimeType(file),
    'Content-Length': data.byteLength,
    'Cache-Control': 'no-cache',
  })
  if (headOnly) res.end()
  else res.end(data)
}

function resolveStaticPath(webRoot: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const root = path.resolve(webRoot)
  const relative = decoded.replace(/^\/+/, '')
  const target = path.resolve(root, relative === '' ? 'index.html' : relative)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return target
}

function mimeType(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const limit = maxBytes
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Uint8Array
    size += buffer.byteLength
    if (size > limit) throw new HttpError(413, '请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body) ?? 'null'
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function fail(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const status = error instanceof HttpError ? error.status : 500
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, status, { ok: false, error: message })
}

export const name = 'host-gateway'
export const inject = ['gateway']

export default { name, inject, apply }
