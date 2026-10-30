/**
 * @qingmei/host-mcp —— 把青梅的能力以 MCP（Streamable HTTP）暴露给外部 agent。
 *
 * 只实现 MCP 的最小面：initialize / tools/list / tools/call。
 * 目前暴露两个工具：memory_recall / memory_remember。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { McpService, type MemoryRecord, type MemoryService } from '@qingmei/core'

export interface McpConfig {
  host?: string
  port?: number
  /** 简单 bearer 校验；DSH 通过 headers 带上 */
  token?: string
  path?: string
}

export const name = 'host-mcp'
export const inject = ['memory']

const PROTOCOL_VERSION = '2024-11-05'

const TOOLS = [
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
  },
]

export class McpHost extends McpService {
  private readonly server: Server
  private readonly options: Required<McpConfig>
  private readonly memory: MemoryService

  constructor(ctx: Context, config: McpConfig = {}) {
    super(ctx)
    const memory = ctx.reflect.get('memory', false) as MemoryService | undefined
    if (!memory) throw new Error('[host-mcp] 缺少 memory 服务')
    this.memory = memory
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
    if (method === 'tools/list') return { tools: TOOLS }
    if (method === 'tools/call') {
      const tool = String(params.name ?? '')
      const args = (params.arguments ?? {}) as Record<string, unknown>
      if (tool === 'memory_recall') {
        const query = String(args.query ?? '').trim()
        if (!query) throw new Error('query 不能为空')
        const limit = Number(args.limit ?? 5)
        const result = await this.memory.recall({ text: query, limit })
        const text = result.text || '没有找到相关记忆。'
        return { content: [{ type: 'text', text }], isError: false }
      }
      if (tool === 'memory_remember') {
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
        const result = await this.memory.ingest([record])
        const action = result.created.length > 0 ? '已记住' : '已更新'
        return { content: [{ type: 'text', text: action }], isError: false }
      }
      throw new Error(`未知工具：${tool}`)
    }
    throw new Error(`未知方法：${method}`)
  }
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
