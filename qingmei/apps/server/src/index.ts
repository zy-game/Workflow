/**
 * 青梅 P1 组合根（assembly root）。
 *
 * 只做三件事：读插件清单、按 name 动态 import、交给 cordis 挂载。
 * 业务配置全部留在 qingmei.yml；插件之间的依赖只由各自的 inject 声明，
 * 清单顺序不代表加载完成顺序。
 */
import { realpathSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import { Context, FiberState } from 'cordis'
import type { Fiber } from 'cordis'
import { getServerInfo } from '@qingmei/host-gateway'
import type { ServerInfo } from '@qingmei/host-gateway'

/** 仓库根目录（apps/server/src → ../../..） */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

/** 默认插件清单；相对路径以仓库根为基准，插件内部的相对路径仍以进程工作目录为准 */
export const DEFAULT_CONFIG = path.join(REPO_ROOT, 'qingmei.yml')

const STARTUP_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 10

export interface PluginEntry {
  /** 包名，按它做动态 import */
  name: string
  /** 原样交给插件的配置 */
  config?: Record<string, unknown>
}

export interface MountedPlugin extends PluginEntry {
  fiber: Fiber
}

export interface StartOptions {
  /** 插件清单路径；默认仓库根的 qingmei.yml */
  configPath?: string
  /** 覆盖清单里带 port 字段的插件配置；0 表示由系统分配端口 */
  port?: number
  /** 覆盖清单里带 host 字段的插件配置 */
  host?: string
  /** 等待全部插件进入 ACTIVE 的超时 */
  timeoutMs?: number
  /** 体检模式：超时或插件 FAILED 时不抛错，改为把状态留给调用方诊断 */
  tolerate?: boolean
}

export interface App {
  ctx: Context
  plugins: MountedPlugin[]
  /** host-gateway 监听成功后的实际地址；清单里没有宿主时为 undefined */
  server?: ServerInfo
  /** 按挂载的逆序卸载全部插件 */
  dispose(): Promise<void>
}

export interface CliOptions {
  configPath?: string
  port?: number
  host?: string
}

export interface ServiceInfo {
  name: string
  impl: string
  owner: string
  ownerState: string
}

export interface ChannelInfo {
  id: string
  online: boolean
}

interface ImplView {
  name: string
  value?: { constructor?: { name?: string } }
  ctx: { fiber: Fiber }
}

// ────────────────────────────────────────────── 配置

/** 读插件清单；任何一处不合规都带位置报错，避免启动到一半才发现拼写问题 */
export function readPluginList(configPath: string = DEFAULT_CONFIG): PluginEntry[] {
  const resolved = path.resolve(configPath)
  let source: string
  try {
    source = readFileSync(resolved, 'utf8')
  } catch (error) {
    throw new Error(`读取插件清单失败：${resolved}（${messageOf(error)}）`)
  }

  let document: unknown
  try {
    document = loadYaml(source)
  } catch (error) {
    throw new Error(`插件清单不是合法 YAML：${resolved}（${messageOf(error)}）`)
  }

  if (!Array.isArray(document)) {
    throw new Error(`插件清单 ${resolved} 的顶层必须是数组，每个元素形如 { name, config }`)
  }

  return document.map((item, index) => normalizeEntry(item, index, resolved))
}

function normalizeEntry(item: unknown, index: number, configPath: string): PluginEntry {
  const where = `${configPath} 第 ${index + 1} 项`
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new Error(`${where} 必须是对象，形如 { name, config }`)
  }
  const record = item as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name.trim() === '') {
    throw new Error(`${where} 缺少非空字符串 name`)
  }
  if (record.config === undefined) return { name: record.name }
  if (typeof record.config !== 'object' || record.config === null || Array.isArray(record.config)) {
    throw new Error(`${where} 的 config 必须是对象`)
  }
  return {
    name: record.name,
    config: resolveEnv(record.config, `${where}.config`) as Record<string, unknown>,
  }
}

/**
 * 解析清单里的密钥引用：
 *   { $env: 'NAME' }  → 环境变量 NAME，缺失即报错（不静默降级为 undefined）
 *   '${NAME}'         → 字符串插值，缺失替换为空串
 * 其它值原样递归处理。
 */
export function resolveEnv(value: unknown, where: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveEnv(item, `${where}[${index}]`))
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 1 && keys[0] === '$env') {
      const envName = record.$env
      if (typeof envName !== 'string' || envName.trim() === '') {
        throw new Error(`${where}.$env 必须是非空字符串`)
      }
      const resolved = process.env[envName]
      if (resolved === undefined) {
        throw new Error(`${where} 引用的环境变量 ${envName} 未设置`)
      }
      return resolved
    }
    const out: Record<string, unknown> = {}
    for (const key of keys) out[key] = resolveEnv(record[key], `${where}.${key}`)
    return out
  }
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '')
  }
  return value
}

/** CLI 覆盖只改清单里已经存在的同名字段，不凭空给插件加配置 */
function applyOverrides(entries: PluginEntry[], options: StartOptions): PluginEntry[] {
  if (options.port === undefined && options.host === undefined) return entries
  return entries.map((entry) => {
    if (!entry.config) return entry
    const config = { ...entry.config }
    if (options.port !== undefined && 'port' in config) config.port = options.port
    if (options.host !== undefined && 'host' in config) config.host = options.host
    return { ...entry, config }
  })
}

// ────────────────────────────────────────────── 启动

/**
 * 按清单挂载全部插件并等待就绪。
 *
 * 先全部挂载再等待：清单里排在提供方前面的消费方会靠 inject 停在 PENDING，
 * 等依赖 Activate 后自动继续，因此清单顺序无关。
 */
export async function startApp(options: StartOptions = {}): Promise<App> {
  const configPath = path.resolve(options.configPath ?? DEFAULT_CONFIG)
  const entries = applyOverrides(readPluginList(configPath), options)
  const ctx = new Context()
  const plugins: MountedPlugin[] = []

  try {
    for (const entry of entries) {
      let module: unknown
      try {
        module = await import(entry.name)
      } catch (error) {
        throw new Error(`加载插件失败 @ ${entry.name}（${messageOf(error)}）`)
      }
      const fiber = ctx.plugin(module, entry.config)
      plugins.push({ ...entry, fiber })
    }
    await settle(plugins, options.timeoutMs ?? STARTUP_TIMEOUT_MS, options.tolerate ?? false)
  } catch (error) {
    await disposePlugins(plugins)
    throw error
  }

  return {
    ctx,
    plugins,
    server: getServerInfo(ctx),
    dispose: () => disposePlugins(plugins),
  }
}

async function settle(plugins: MountedPlugin[], timeoutMs: number, tolerate = false): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const failed = plugins.filter((plugin) => plugin.fiber.state === FiberState.FAILED)
    if (failed.length > 0 && !tolerate) {
      throw new Error(
        `插件加载失败：${failed.map((plugin) => `${plugin.name}（${failureReason(plugin.fiber)}）`).join('、')}`,
      )
    }
    const pending = plugins.filter((plugin) => plugin.fiber.state !== FiberState.ACTIVE)
    if (pending.length === 0) return
    if (Date.now() > deadline) {
      if (tolerate) return
      throw new Error(
        `插件未在 ${timeoutMs}ms 内就绪：${pending
          .map((plugin) => `${plugin.name}（${stateName(plugin.fiber.state)}）`)
          .join('、')}`,
      )
    }
    await delay(POLL_INTERVAL_MS)
  }
}

async function disposePlugins(plugins: MountedPlugin[]): Promise<void> {
  for (const plugin of [...plugins].reverse()) {
    try {
      await plugin.fiber.dispose()
    } catch (error) {
      console.error(`[qm] 卸载插件失败 @ ${plugin.name}：${messageOf(error)}`)
    }
  }
}

/** fiber 失败时 cordis 把错误留在 _error 上；doctor 与启动报错共用这一处提取 */
export function failureReason(fiber: Fiber): string {
  const error = (fiber as unknown as { _error?: unknown })._error
  return error === undefined ? '原因未记录' : messageOf(error)
}

// ────────────────────────────────────────────── 状态

const STATE_NAMES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const

export function stateName(state: number): string {
  return STATE_NAMES[state] ?? `UNKNOWN(${state})`
}

/** 从 cordis 的服务注册表读已注册服务；同名旧实现被新实现覆盖时只留活着的那个 */
export function listServices(ctx: Context): ServiceInfo[] {
  const store = (ctx.reflect as unknown as { store: Record<symbol, ImplView> }).store
  const found = new Map<string, ServiceInfo>()
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    if (!impl || typeof impl.name !== 'string') continue
    const state = impl.ctx.fiber.state
    const info: ServiceInfo = {
      name: impl.name,
      impl: impl.value?.constructor?.name ?? 'unknown',
      owner: impl.ctx.fiber.name,
      ownerState: stateName(state),
    }
    const previous = found.get(info.name)
    if (!previous || (previous.ownerState !== 'ACTIVE' && info.ownerState === 'ACTIVE')) {
      found.set(info.name, info)
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function listChannels(ctx: Context): ChannelInfo[] {
  const channel = ctx.reflect.get('channel', false) as
    | { status?: () => ChannelInfo[] }
    | undefined
  if (!channel || typeof channel.status !== 'function') return []
  try {
    return channel.status()
  } catch {
    return []
  }
}

// ────────────────────────────────────────────── 输出

/** 启动后打印的监听地址、插件、服务与渠道；不打印任何插件 config（可能含 token） */
export function startupLines(app: App, configPath: string): string[] {
  const lines = [
    '',
    '青梅 P1 · 已启动',
    `  配置文件  ${path.resolve(configPath)}`,
    `  监听地址  ${app.server?.url ?? '（未加载 host-gateway，无监听地址）'}`,
    `  已挂载插件（${app.plugins.length}）`,
  ]
  for (const plugin of app.plugins) {
    lines.push(`    ${stateName(plugin.fiber.state).padEnd(9)} ${plugin.name}`)
  }

  const services = listServices(app.ctx)
  lines.push(`  已注册服务（${services.length}）`)
  for (const service of services) {
    lines.push(`    ${service.name.padEnd(9)} ← ${service.impl} @ ${service.owner}`)
  }

  const channels = listChannels(app.ctx)
  lines.push(`  渠道（${channels.length}）`)
  for (const channel of channels) {
    lines.push(`    ${channel.id.padEnd(9)} ${channel.online ? 'online' : 'offline'}`)
  }
  lines.push('')
  return lines
}

export function printStartup(app: App, configPath: string): void {
  console.log(startupLines(app, configPath).join('\n'))
}

// ────────────────────────────────────────────── CLI

/** 解析 --config / --port / --host；未知参数直接报错，避免拼错后静默使用默认值 */
export function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const takeValue = (): string => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`参数 ${arg} 缺少值`)
      }
      index++
      return value
    }
    if (arg === '--config') {
      options.configPath = takeValue()
    } else if (arg === '--port') {
      const value = Number(takeValue())
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error(`--port 必须是 0..65535 的整数`)
      }
      options.port = value
    } else if (arg === '--host') {
      options.host = takeValue()
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

export function isEntrypoint(moduleUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false
  const self = fileURLToPath(moduleUrl)
  try {
    return realpathSync(self).toLowerCase() === realpathSync(entry).toLowerCase()
  } catch {
    return path.resolve(self).toLowerCase() === path.resolve(entry).toLowerCase()
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ────────────────────────────────────────────── 直接运行 = qm serve

/**
 * 启动并保持运行，直到收到 SIGINT/SIGTERM；收到信号后按逆序卸载插件再返回。
 * cli 的 `qm serve` 也走这里，保证两个入口行为一致。
 */
export async function serve(options: StartOptions = {}): Promise<void> {
  const app = await startApp(options)
  printStartup(app, options.configPath ?? DEFAULT_CONFIG)
  if (!app.server) {
    console.log('[qm] 清单里没有 host-gateway，进程保持运行但没有监听地址。')
  }

  await new Promise<void>((resolve, reject) => {
    let closing = false
    const shutdown = (signal: string): void => {
      if (closing) return
      closing = true
      console.log(`\n[qm] 收到 ${signal}，正在卸载插件…`)
      app.dispose().then(
        () => resolve(),
        (error: unknown) => reject(error),
      )
    }
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))
  })
}

if (isEntrypoint(import.meta.url)) {
  serve(parseOptions(process.argv.slice(2))).then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(`[qm] 启动失败：${messageOf(error)}`)
      process.exit(1)
    },
  )
}
