/**
 * @qingmei/host-mcp —— 把青梅的能力以 MCP（Streamable HTTP）暴露给外部 agent。
 *
 * 只实现 MCP 的最小面：initialize / tools/list / tools/call。
 * 工具是「一份定义 + 一个 handler」的注册表（见 createTools）：
 * tools/list 与 tools/call 读同一份，新增工具只改一处。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import {
  McpService,
  type MemoryRecord,
  type MemoryService,
  type Scheduled,
  type ScheduleInput,
  type SchedulePatch,
  type ScheduleService,
} from '@qingmei/core'

export interface McpConfig {
  host?: string
  port?: number
  /** 简单 bearer 校验；DSH 通过 headers 带上 */
  token?: string
  path?: string
}

export const name = 'host-mcp'
export const inject = ['memory', 'schedule']

const PROTOCOL_VERSION = '2024-11-05'

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError: boolean
}

export interface HostTool {
  name: string
  description: string
  /** JSON Schema（MCP tools/list 直接透出） */
  inputSchema: Record<string, unknown>
  call(args: Record<string, unknown>): Promise<ToolResult>
}

export interface ToolDeps {
  memory: MemoryService
  schedule: ScheduleService
}

/** 工具注册表：新增能力只在这里加一项，schema、描述、处理逻辑都在一处 */
export function createTools(deps: ToolDeps): HostTool[] {
  return [
    {
      name: 'memory_recall',
      description: '召回青梅记住的、与查询相关的事实。回答用户问题前应先查一次。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查询的内容，用用户的原话或关键词' },
          limit: { type: 'number', description: '最多返回几条，默认 5' },
        },
        required: ['query'],
      },
      async call(args) {
        const query = String(args.query ?? '').trim()
        if (!query) throw new Error('query 不能为空')
        const result = await deps.memory.recall({ text: query, limit: Number(args.limit ?? 5) })
        return textResult(result.text || '没有找到相关记忆。')
      },
    },
    {
      name: 'memory_remember',
      description: '把一条值得长期记住的事实写入青梅的记忆。',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          predicate: { type: 'string' },
          object: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['subject', 'predicate', 'object'],
      },
      async call(args) {
        const record: MemoryRecord = {
          kind: 'fact',
          subject: String(args.subject ?? '').trim(),
          predicate: String(args.predicate ?? '').trim(),
          object: String(args.object ?? '').trim(),
          confidence: Number(args.confidence ?? 0.8),
          sensitivity: 'private',
          origin: { kind: 'harness', id: 'mcp' },
        }
        if (!record.subject || !record.predicate || !record.object) {
          throw new Error('subject/predicate/object 都不能为空')
        }
        const result = await deps.memory.ingest([record])
        return textResult(result.created.length > 0 ? '已记住' : '已更新')
      },
    },
    {
      name: 'schedule_create',
      description:
        '创建提醒。cron 表示按周期重复（五段式“分 时 日 月 周”，可配 timezone），用于“每天九点”这类请求；' +
        'at 表示绝对时间一次性触发；只给 seconds 表示多少秒后提醒一次。优先级 cron > at > seconds。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '提醒内容' },
          cron: { type: 'string', description: '五段式 cron：分 时 日 月 周，如 0 9 * * 1-5' },
          timezone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai；缺省用服务器配置的默认时区' },
          missedPolicy: {
            type: 'string',
            enum: ['fire-once', 'skip'],
            description: '停机期间错过多次时补发一次（默认）还是跳过',
          },
          at: { type: 'string', description: '绝对时间（ISO 8601），一次性' },
          seconds: { type: 'number', description: '多少秒后提醒，默认 60' },
        },
        required: ['text'],
      },
      async call(args) {
        const text = String(args.text ?? '').trim()
        if (!text) throw new Error('text 不能为空')
        const item = await deps.schedule.create(scheduleInputFrom(text, args))
        return textResult(`已设定：${describeWhen(item)} 提醒「${text}」`)
      },
    },
    {
      name: 'schedule_cancel',
      description: '按 id 取消一条提醒（永久删除）。只想暂时别响用 schedule_pause。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      async call(args) {
        const ok = await deps.schedule.cancel(String(args.id ?? ''))
        return textResult(ok ? '已取消' : '没有找到这条提醒')
      },
    },
    {
      name: 'schedule_update',
      description:
        '按 id 修改提醒的内容或规则（cron / at / seconds 三选一）。只给 text 就只改文案；给了规则会从现在重排下一次。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '日程 id' },
          text: { type: 'string', description: '新的提醒内容' },
          cron: { type: 'string', description: '新的五段式 cron' },
          timezone: { type: 'string', description: '新的 IANA 时区' },
          at: { type: 'string', description: '新的绝对时间（ISO 8601），一次性' },
          seconds: { type: 'number', description: '改成「多少秒后」的一次性提醒' },
          missedPolicy: {
            type: 'string',
            enum: ['fire-once', 'skip'],
            description: '停机期间错过多次时补发一次还是跳过',
          },
        },
        required: ['id'],
      },
      async call(args) {
        const id = String(args.id ?? '').trim()
        if (!id) throw new Error('id 不能为空')
        const item = await deps.schedule.update(id, schedulePatchFrom(args))
        if (!item) throw new Error('这条提醒不存在或已经结束')
        return textResult(`已修改：${describeWhen(item)} 提醒「${item.text}」`)
      },
    },
    {
      name: 'schedule_pause',
      description: '按 id 暂停一条提醒：保留规则，但到点不再触发。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      async call(args) {
        const ok = await deps.schedule.pause(String(args.id ?? ''))
        return textResult(ok ? '已暂停' : '没有找到这条提醒')
      },
    },
    {
      name: 'schedule_resume',
      description: '按 id 继续一条被暂停的提醒。周期提醒会从「现在」重新排下一次。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      async call(args) {
        const ok = await deps.schedule.resume(String(args.id ?? ''))
        return textResult(ok ? '已继续' : '这条提醒不存在或已经结束')
      },
    },
    {
      name: 'schedule_list',
      description: '列出所有未触发的提醒（含已暂停的，暂停状态会标出来）。',
      inputSchema: { type: 'object', properties: {} },
      async call() {
        const items = await deps.schedule.list()
        const active = items.filter((item) => item.firedAt === null)
        // 带上 id：没有 id，模型就无法用 schedule_cancel 取消已有日程
        const text = active.length
          ? active.map((item) => `- [${item.id}] ${describeWhen(item)} ${item.text}`).join('\n')
          : '没有待触发的提醒。'
        return textResult(text)
      },
    },
  ]
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: false }
}

export class McpHost extends McpService {
  private readonly server: Server
  private readonly options: Required<McpConfig>
  private readonly tools: HostTool[]
  private readonly toolsByName: Map<string, HostTool>

  constructor(ctx: Context, config: McpConfig = {}) {
    super(ctx)
    const memory = ctx.reflect.get('memory', false) as MemoryService | undefined
    if (!memory) throw new Error('[host-mcp] 缺少 memory 服务')
    const schedule = ctx.reflect.get('schedule', false) as ScheduleService | undefined
    if (!schedule) throw new Error('[host-mcp] 缺少 schedule 服务')

    this.tools = createTools({ memory, schedule })
    this.toolsByName = new Map(this.tools.map((tool) => [tool.name, tool]))
    this.options = {
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 7420,
      token: config.token ?? '',
      path: config.path ?? '/mcp',
    }
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
    this.server.listen(this.options.port, this.options.host)
    ctx.effect(() => () => {
      this.server.close()
    })
  }

  servers(): unknown[] {
    const headers = this.options.token
      ? [{ name: 'Authorization', value: `Bearer ${this.options.token}` }]
      : undefined
    return [
      {
        type: 'http',
        name: 'qingmei',
        url: `http://${this.options.host}:${this.options.port}${this.options.path}`,
        ...(headers ? { headers } : {}),
      },
    ]
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== this.options.path) {
      res.writeHead(404).end()
      return
    }
    if (this.options.token) {
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${this.options.token}`) {
        sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' } })
        return
      }
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }

    const body = await readJson(req)
    if (body === null) {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } })
      return
    }
    const message = body as { id?: number | string; method?: string; params?: Record<string, unknown> }
    if (message.method === 'notifications/initialized' || message.id === undefined) {
      res.writeHead(202).end()
      return
    }

    try {
      const result = await this.dispatch(message.method ?? '', message.params ?? {})
      sendJson(res, 200, { jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: messageOf(error) },
      })
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'initialize') {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'qingmei-memory', version: '0.1.0' },
      }
    }
    if (method === 'ping') return {}
    if (method === 'tools/list') {
      return {
        tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      }
    }
    if (method === 'tools/call') {
      const name = String(params.name ?? '')
      const tool = this.toolsByName.get(name)
      if (!tool) throw new Error(`未知工具：${name}`)
      const args = (params.arguments ?? {}) as Record<string, unknown>
      return await tool.call(args)
    }
    throw new Error(`未知方法：${method}`)
  }
}

/**
 * 把工具参数折成 ScheduleInput。
 *
 * cron 优先，其次 ISO 时间，最后才是 seconds 倒计时。秒级请求一律换算成绝对时间，
 * 走一次性路径——否则“60 秒后提醒我”会变成每 60 秒重复一次。
 */
export function scheduleInputFrom(text: string, args: Record<string, unknown>): ScheduleInput {
  const cron = typeof args.cron === 'string' ? args.cron.trim() : ''
  const timezone = typeof args.timezone === 'string' ? args.timezone.trim() : ''
  const missedPolicy =
    args.missedPolicy === 'skip' ? 'skip' : args.missedPolicy === 'fire-once' ? 'fire-once' : undefined
  if (cron) {
    return {
      text,
      cron,
      ...(timezone ? { timezone } : {}),
      ...(missedPolicy ? { missedPolicy } : {}),
    }
  }

  const atRaw = typeof args.at === 'string' ? Date.parse(args.at) : Number.NaN
  if (Number.isFinite(atRaw)) return { text, at: new Date(atRaw) }

  const seconds = Number(args.seconds ?? 60)
  const delayMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000
  return { text, at: new Date(Date.now() + delayMs) }
}

/**
 * 把工具参数折成 SchedulePatch（只带显式给出的字段）。
 *
 * 一个字段都没有就报错：静默什么都不改比报错更难查。
 */
export function schedulePatchFrom(args: Record<string, unknown>): SchedulePatch {
  const patch: SchedulePatch = {}
  if (typeof args.text === 'string') patch.text = args.text
  if (typeof args.cron === 'string' && args.cron.trim()) patch.cron = args.cron.trim()
  if (typeof args.timezone === 'string' && args.timezone.trim()) patch.timezone = args.timezone.trim()
  const atRaw = typeof args.at === 'string' ? Date.parse(args.at) : Number.NaN
  if (Number.isFinite(atRaw)) patch.at = new Date(atRaw)
  const seconds = Number(args.seconds)
  if (Number.isFinite(seconds) && seconds > 0) patch.everyMs = seconds * 1000
  if (args.missedPolicy === 'skip' || args.missedPolicy === 'fire-once') {
    patch.missedPolicy = args.missedPolicy
  }
  if (Object.keys(patch).length === 0) throw new Error('没有可修改的字段')
  return patch
}

function describeWhen(item: Scheduled): string {
  const paused = item.pausedAt ? '（已暂停）' : ''
  if (item.cron) {
    return `${paused}每次 ${item.cron}（${item.timezone ?? '默认时区'}），下次 ${item.nextAt.toISOString()}`
  }
  return `${paused}${item.nextAt.toISOString()}`
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
      if (raw.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: Context, config: McpConfig = {}): void {
  ctx.plugin(McpHost, config)
}

export const defaultExport = { name, inject, apply }
