/**
 * @qingmei/host-gateway —— 用 node:http 承载网关服务。
 *
 * 职责边界：只做传输（静态文件、鉴权、SSE、JSON），
 * 业务路由与事件广播仍然在 gateway 服务里。
 */
import { timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { Context } from 'cordis'
import {
  EVENTS,
  listenerCount,
  uid,
  type ChannelService,
  type GatewayEvent,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type InboundMessage,
  type Row,
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
}

interface HandlerDeps {
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
  return { host, port, token, webRoot: path.resolve(config.webRoot ?? 'apps/web/public') }
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

  const startedAt = Date.now()
  const clients = new Set<ServerResponse>()
  const deps: HandlerDeps = { ctx, gateway, options, clients, startedAt }
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

  if (pathname === '/healthz') {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed')
    const consumers = listenerCount(deps.ctx, EVENTS.inbound)
    const payload = {
      // 没有入站消费者时健康检查必须为 false：否则消息会被静默丢弃。
      ok: consumers !== 0,
      uptime: Math.floor((Date.now() - deps.startedAt) / 1000),
      agent: consumers,
      channels: channelStatus(deps.ctx),
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

  if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
    if (!authorized(req, url, deps.options.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
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
      sendJson(res, 200, await readHistory(deps.ctx, conversationId, limit))
      return
    }

    await dispatchGatewayRoute(deps, req, res, url, method)
    return
  }

  if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed')
  await serveStatic(res, deps.options.webRoot, pathname, method === 'HEAD')
}

function channelStatus(ctx: Context): { id: string; online: boolean }[] {
  const channel = ctx.reflect.get('channel', true) as ChannelService | undefined
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
function authorized(req: IncomingMessage, url: URL, expected: string): boolean {
  const headerToken = bearerOf(req.headers.authorization)
  if (headerToken !== undefined) return tokenMatches(headerToken, expected)
  if (req.method === 'GET' && url.pathname === '/api/v1/events') {
    return tokenMatches(url.searchParams.get('token') ?? undefined, expected)
  }
  return false
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
  const text = record.text
  if (typeof text !== 'string' || text.trim() === '') {
    throw new HttpError(400, 'text 必须是非空字符串')
  }
  const rawConversationId = record.conversationId
  if (rawConversationId !== undefined && typeof rawConversationId !== 'string') {
    throw new HttpError(400, 'conversationId 必须是字符串')
  }
  const conversationId =
    rawConversationId !== undefined && rawConversationId.trim() !== '' ? rawConversationId : 'owner'

  const message: InboundMessage = {
    platformMessageId: uid('msg'),
    channel: 'web',
    accountId: 'web',
    conversation: { kind: 'dm', id: conversationId },
    sender: { platformUserId: 'owner', displayName: '我' },
    blocks: [{ type: 'text', text }],
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
  conversationId: string | undefined,
  limit: number,
): Promise<MessageRow[]> {
  const store = ctx.reflect.get('store', true) as StoreService | undefined
  if (!store) return []
  try {
    // P1 的 store 只在 JS 侧做过滤/排序，这里取全量再裁剪，
    // 以免把某一版的列命名（session_id / conversationId）写死进查询。
    const rows = await store.collection<MessageRow>('qm_message').find({})
    const scoped = conversationId
      ? rows.filter((row) => belongsToConversation(row, conversationId))
      : [...rows]
    scoped.sort((a, b) => createdAtOf(a) - createdAtOf(b))
    return scoped.slice(-limit)
  } catch (error) {
    ctx.logger.warn('读取 qm_message 历史失败，按空历史返回:', error)
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Uint8Array
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大')
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
