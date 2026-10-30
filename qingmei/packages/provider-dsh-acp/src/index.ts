/**
 * @qingmei/provider-dsh-acp —— 把 DeepSeek Harness 作为内嵌 agent runtime 接入。
 *
 * 与 provider-llm-openai 的分工：
 *   - 本包：对话车道，DSH 拥有会话、工具、上下文压缩；
 *   - llm 包：后台结构化任务（抽取/分类/摘要）。
 */
import type { Context } from 'cordis'
import path from 'node:path'
import {
  HarnessService,
  type HarnessEvent,
  type HarnessRequest,
} from '@qingmei/core'
import { AcpClient, type AcpUpdate } from './acp-client.ts'

export interface DshHarnessConfig {
  /** dsh 可执行文件 */
  command?: string
  /** 默认 ['--profile', 'acp'] */
  args?: string[]
  /** 会话工作目录；DSH 的工具都在这里活动 */
  cwd?: string
  /** 追加给子进程的环境变量（如 QM_DSH_API_KEY） */
  env?: Record<string, string | undefined>
  /** 单个请求超时 */
  timeoutMs?: number
}

export const name = 'provider-dsh-acp'

const DEFAULTS = {
  command: '/usr/local/bin/dsh',
  args: ['--profile', 'acp'],
  timeoutMs: 120_000,
}

export class DshHarness extends HarnessService {
  private readonly config: DshHarnessConfig
  private client: AcpClient | null = null
  /** conversationId → ACP sessionId */
  private readonly sessions = new Map<string, string>()
  /** sessionId → 当前回合的事件队列 */
  private readonly turns = new Map<string, AsyncQueue<HarnessEvent>>()

  constructor(ctx: Context, config: DshHarnessConfig = {}) {
    super(ctx)
    this.config = { ...DEFAULTS, ...config }
    // Service 的 ctx 就是插件 fiber 的 context：卸载时杀子进程
    ctx.effect(() => () => this.stop())
  }

  async available(): Promise<boolean> {
    try {
      await this.ensureClient()
      return true
    } catch {
      return false
    }
  }

  async *run(req: HarnessRequest): AsyncIterable<HarnessEvent> {
    let client: AcpClient
    try {
      client = await this.ensureClient()
    } catch (error) {
      yield { type: 'error', message: `harness 不可用：${messageOf(error)}` }
      return
    }

    let sessionId: string
    try {
      sessionId = await this.ensureSession(client, req.conversationId, req.cwd)
    } catch (error) {
      yield { type: 'error', message: `建立会话失败：${messageOf(error)}` }
      return
    }

    const queue = new AsyncQueue<HarnessEvent>()
    this.turns.set(sessionId, queue)
    const onAbort = () => client.cancel(sessionId)
    req.signal?.addEventListener('abort', onAbort, { once: true })

    const finished = client
      .prompt(sessionId, req.text)
      .then((result) => {
        queue.push({ type: 'done', stopReason: result.stopReason })
      })
      .catch((error: unknown) => {
        queue.push({ type: 'error', message: messageOf(error) })
      })
      .finally(() => queue.close())

    try {
      for await (const event of queue) yield event
      await finished
    } finally {
      this.turns.delete(sessionId)
      req.signal?.removeEventListener('abort', onAbort)
    }
  }

  async close(conversationId: string): Promise<void> {
    const sessionId = this.sessions.get(conversationId)
    if (!sessionId) return
    this.sessions.delete(conversationId)
    try {
      await this.client?.closeSession(sessionId)
    } catch {
      // 会话可能已随进程消失；关闭失败不影响后续新建
    }
  }

  stop(): void {
    this.sessions.clear()
    this.turns.clear()
    this.client?.stop()
    this.client = null
  }

  private async ensureClient(): Promise<AcpClient> {
    if (this.client?.alive) return this.client
    const client = new AcpClient({
      command: this.config.command ?? DEFAULTS.command,
      args: this.config.args ?? DEFAULTS.args,
      // ACP 要求绝对路径：配置里写 './workspace' 也能用
      cwd: path.resolve(this.config.cwd ?? process.cwd()),
      env: this.config.env,
      timeoutMs: this.config.timeoutMs ?? DEFAULTS.timeoutMs,
      onUpdate: (update) => this.dispatch(update),
    })
    await client.start()
    this.client = client
    return client
  }

  private async ensureSession(
    client: AcpClient,
    conversationId: string,
    cwd?: string,
  ): Promise<string> {
    const existing = this.sessions.get(conversationId)
    if (existing) return existing
    const base = path.resolve(cwd ?? this.config.cwd ?? process.cwd())
    // 有 mcp 服务就把青梅自己的工具注入会话；没有则退回纯对话
    const mcp = this.ctx.reflect.get('mcp', false) as { servers(): unknown[] } | undefined
    const mcpServers = mcp?.servers() ?? []
    const sessionId = await client.newSession(base, mcpServers)
    this.sessions.set(conversationId, sessionId)
    return sessionId
  }

  private dispatch(update: AcpUpdate): void {
    const queue = this.turns.get(update.sessionId)
    if (!queue) return
    const kind = update.update?.sessionUpdate
    if (kind === 'agent_message_chunk') {
      const content = update.update.content as { text?: string } | undefined
      if (typeof content?.text === 'string' && content.text.length > 0) {
        queue.push({ type: 'text', text: content.text })
      }
      return
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const title = (update.update.title ?? update.update.name ?? 'tool') as string
      const status = (update.update.status ?? 'running') as string
      queue.push({ type: 'tool', name: String(title), status: String(status) })
    }
  }
}

/** 极简异步队列：把回调式事件转成 async iterable */
class AsyncQueue<T> {
  private readonly items: T[] = []
  private readonly waiters: ((value: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: Context, config: DshHarnessConfig = {}): void {
  ctx.plugin(DshHarness, config)
}

export const defaultExport = { name, apply }
