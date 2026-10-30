/**
 * ACP（Agent Client Protocol）stdio 客户端。
 *
 * 只做协议：拉起子进程、发请求、收通知。业务语义在 DshHarness 里。
 * 方法与事件以 ACP v1 为准；DSH 的 `--profile acp` 已实测可用。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface AcpUpdate {
  sessionId: string
  update: Record<string, unknown>
}

export interface AcpClientOptions {
  command: string
  args: string[]
  cwd: string
  /** 追加/覆盖的环境变量（父进程环境仍会继承） */
  env?: Record<string, string | undefined>
  timeoutMs?: number
  onUpdate?: (update: AcpUpdate) => void
  onStderr?: (text: string) => void
  onExit?: (code: number | null) => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class AcpClient {
  private readonly options: AcpClientOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private ready = false

  constructor(options: AcpClientOptions) {
    this.options = { timeoutMs: 120_000, ...options }
  }

  get alive(): boolean {
    return this.child !== null
  }

  /** 拉起进程并完成 initialize；可重复调用。 */
  async start(): Promise<void> {
    if (this.ready && this.child) return
    if (!this.child) this.spawnChild()
    await this.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    this.ready = true
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const result = (await this.request('session/new', { cwd, mcpServers })) as {
      sessionId?: string
    }
    if (!result?.sessionId) throw new Error('[acp] session/new 未返回 sessionId')
    return result.sessionId
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const result = (await this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    })) as { stopReason?: string }
    return { stopReason: result?.stopReason ?? 'end_turn' }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request('session/close', { sessionId })
  }

  /** 取消当前回合；ACP 里是通知，不占请求 id。 */
  cancel(sessionId: string): void {
    this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  }

  stop(): void {
    const child = this.child
    this.child = null
    this.ready = false
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('[acp] client stopped'))
    }
    this.pending.clear()
    if (child && !child.killed) child.kill()
  }

  private spawnChild(): void {
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.buffer = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.receive(chunk))
    child.stderr.on('data', (chunk: unknown) => this.options.onStderr?.(String(chunk)))
    child.on('exit', (code) => {
      this.child = null
      this.ready = false
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`[acp] 子进程退出（code=${code}）`))
      }
      this.pending.clear()
      this.options.onExit?.(code)
    })
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.dispatch(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.options.onStderr?.(`[acp] 非 JSON 输出：${line.slice(0, 200)}\n`)
      return
    }
    const id = message.id
    if (typeof id === 'number' && this.pending.has(id)) {
      const pending = this.pending.get(id)!
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result ?? null)
      return
    }
    if (message.method === 'session/update') {
      const params = message.params as { sessionId?: string; update?: Record<string, unknown> }
      if (params?.sessionId && params.update) {
        this.options.onUpdate?.({ sessionId: params.sessionId, update: params.update })
      }
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`[acp] 请求超时：${method}`))
      }, this.options.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private write(message: unknown): void {
    if (!this.child) throw new Error('[acp] 子进程未启动')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
}
