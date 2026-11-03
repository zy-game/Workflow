/**
 * ACP（Agent Client Protocol）stdio 客户端。
 *
 * 只做协议：拉起子进程、发请求、收通知。业务语义在 DshHarness 里。
 * 方法与事件以 ACP v1 为准；DSH 的 `--profile acp` 已实测可用。
 *
 * 除了发请求，客户端还要**实现** agent 会反向调用的方法：
 * `fs/read_text_file` / `fs/write_text_file` 与 `terminal/*`——没有它们，
 * 子 agent 的文件与命令工具会失败（模型会以为「自己没有文件权限」）。
 * 文件访问一律限制在会话 cwd 内（docs/07 §8 的目录约束）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface AcpUpdate {
  sessionId: string
  update: Record<string, unknown>
}

/** ACP `session/prompt` 响应里的 token 用量（实验字段） */
export interface AcpUsage {
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
}

/** ACP `session/request_permission` 的参数（v1 schema） */
export interface AcpPermissionRequest {
  sessionId: string
  toolCall?: { title?: string; name?: string; [key: string]: unknown }
  options?: { optionId: string; name: string; kind: string }[]
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
  /**
   * 子 agent 请求权限时调用：返回要选的 optionId，返回 null 表示取消。
   * 业务语义（审批队列）在 DshHarness 里，客户端只负责协议往返。
   */
  onPermissionRequest?: (request: AcpPermissionRequest) => Promise<string | null>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface TerminalHandle {
  child: ChildProcessWithoutNullStreams
  output: string
  truncated: boolean
  limit: number
  exitCode: number | null
  signal: string | null
  exit: Promise<{ exitCode: number | null; signal: string | null }>
}

interface TerminalCreateParams {
  sessionId?: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  outputByteLimit?: number
}

export class AcpClient {
  private readonly options: AcpClientOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private readonly sessions = new Map<string, string>()
  private readonly terminals = new Map<string, TerminalHandle>()
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
    await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'qingmei', version: '0.1.0' },
      // 必须显式声明：默认 fs/terminal 都是 false，agent 会因此不提供文件/命令工具
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    })
    this.ready = true
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const result = (await this.request('session/new', { cwd, mcpServers })) as {
      sessionId?: string
    }
    if (!result?.sessionId) throw new Error('[acp] session/new 未返回 sessionId')
    this.sessions.set(result.sessionId, path.resolve(cwd))
    return result.sessionId
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const result = (await this.request('session/load', { sessionId, cwd, mcpServers })) as {
      sessionId?: string
    }
    const loaded = result?.sessionId ?? sessionId
    this.sessions.set(loaded, path.resolve(cwd))
    return loaded
  }
  async prompt(sessionId: string, text: string): Promise<{ stopReason: string; usage?: AcpUsage }> {
    const result = (await this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    })) as { stopReason?: string; usage?: AcpUsage }
    return { stopReason: result?.stopReason ?? 'end_turn', ...(result?.usage ? { usage: result.usage } : {}) }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request('session/close', { sessionId })
  }

  /** 取消当前回合；ACP 里是通知，不占请求 id。 */
  cancel(sessionId: string): void {
    this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  }

  stop(): void {
    for (const [, terminal] of this.terminals) {
      if (terminal.child.exitCode === null && terminal.child.signalCode === null) terminal.child.kill()
    }
    this.terminals.clear()
    this.sessions.clear()
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

    // agent → client 的方法调用/通知：必须先按 method 分流，
    // 否则 agent 的请求 id 可能撞上我们 pending 里的 id
    if (typeof message.method === 'string') {
      const method = message.method
      if (method === 'session/update') {
        const params = message.params as { sessionId?: string; update?: Record<string, unknown> }
        if (params?.sessionId && params.update) {
          this.options.onUpdate?.({ sessionId: params.sessionId, update: params.update })
        }
        return
      }
      if (message.id !== undefined) void this.handleAgentRequest(message.id, method, message.params)
      return
    }

    const id = message.id
    if (typeof id === 'number' && this.pending.has(id)) {
      const pending = this.pending.get(id)!
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result ?? null)
    }
  }

  /** agent 反向调用的方法：权限、文件、终端；其余一律回 method not found */
  private async handleAgentRequest(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.dispatchAgentMethod(method, params)
      this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  private async dispatchAgentMethod(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'session/request_permission':
        return { outcome: await this.permissionOutcome(params as AcpPermissionRequest) }
      case 'fs/read_text_file':
        return { content: await this.readTextFile(params as { sessionId: string; path: string; line?: number; limit?: number }) }
      case 'fs/write_text_file':
        await this.writeTextFile(params as { sessionId: string; path: string; content: string })
        return null
      case 'terminal/create':
        return this.createTerminal(params as TerminalCreateParams)
      case 'terminal/output':
        return this.terminalOutput((params as { terminalId: string }).terminalId)
      case 'terminal/wait_for_exit':
        return await this.terminals.get((params as { terminalId: string }).terminalId)?.exit ?? { exitCode: null, signal: null }
      case 'terminal/kill':
        this.terminals.get((params as { terminalId: string }).terminalId)?.child.kill()
        return null
      case 'terminal/release': {
        const terminalId = (params as { terminalId: string }).terminalId
        const terminal = this.terminals.get(terminalId)
        if (terminal) {
          if (terminal.child.exitCode === null && terminal.child.signalCode === null) terminal.child.kill()
          this.terminals.delete(terminalId)
        }
        return null
      }
      default:
        throw new Error(`[acp] 未实现的方法：${method}`)
    }
  }

  private async permissionOutcome(params: AcpPermissionRequest): Promise<unknown> {
    let optionId: string | null = null
    try {
      optionId = (await this.options.onPermissionRequest?.(params)) ?? null
    } catch (error) {
      this.options.onStderr?.(`[acp] 权限请求处理失败：${String(error)}\n`)
      optionId = null
    }
    return optionId
      ? { outcome: 'selected', optionId }
      : { outcome: 'cancelled' }
  }

  /** 会话内路径：必须落在 newSession 的 cwd 里，越界直接拒绝 */
  private resolveSessionPath(sessionId: string, target: string): string {
    const root = this.sessions.get(sessionId)
    if (!root) throw new Error(`[acp] 未知会话：${sessionId}`)
    if (typeof target !== 'string' || target.length === 0) throw new Error('[acp] 路径不能为空')
    const resolved = path.resolve(root, target)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`[acp] 路径越界（只允许会话目录内）：${target}`)
    }
    return resolved
  }

  private async readTextFile(params: { sessionId: string; path: string; line?: number; limit?: number }): Promise<string> {
    const file = this.resolveSessionPath(params.sessionId, params.path)
    const text = await readFile(file, 'utf8')
    if (params.line === undefined && params.limit === undefined) return text
    const lines = text.split('\n')
    const start = Math.max(0, (params.line ?? 1) - 1)
    const end = params.limit === undefined ? lines.length : start + params.limit
    return lines.slice(start, end).join('\n')
  }

  private async writeTextFile(params: { sessionId: string; path: string; content: string }): Promise<void> {
    const file = this.resolveSessionPath(params.sessionId, params.path)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, String(params.content ?? ''), 'utf8')
  }

  private createTerminal(params: TerminalCreateParams): { terminalId: string } {
    const cwd = params.sessionId ? this.resolveSessionPath(params.sessionId, params.cwd ?? '.') : process.cwd()
    const limit = params.outputByteLimit ?? 1_000_000
    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env: { ...process.env, ...(params.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const terminal: TerminalHandle = {
      child,
      output: '',
      truncated: false,
      limit,
      exitCode: null,
      signal: null,
      exit: Promise.resolve().then(
        () =>
          new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
            child.once('exit', (code, signal) => {
              terminal.exitCode = code
              terminal.signal = signal
              resolve({ exitCode: code, signal })
            })
          }),
      ),
    }

    const append = (chunk: Buffer): void => {
      if (terminal.truncated) return
      const text = chunk.toString('utf8')
      if (terminal.output.length + text.length > limit) {
        terminal.output += text.slice(0, Math.max(0, limit - terminal.output.length))
        terminal.truncated = true
        return
      }
      terminal.output += text
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const terminalId = `term_${++this.seq}`
    this.terminals.set(terminalId, terminal)
    return { terminalId }
  }

  private terminalOutput(terminalId: string): { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal: string | null } } {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) throw new Error(`[acp] 未知终端：${terminalId}`)
    const payload: { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal: string | null } } = {
      output: terminal.output,
      truncated: terminal.truncated,
    }
    if (terminal.exitCode !== null || terminal.signal !== null) {
      payload.exitStatus = { exitCode: terminal.exitCode, signal: terminal.signal }
    }
    return payload
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
