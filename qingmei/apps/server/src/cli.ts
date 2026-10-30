/**
 * 青梅 P1 命令行。
 *
 *   qm serve   —— 等价于 apps/server/src/index.ts
 *   qm doctor  —— 启动同一个组合根，然后打印插件 fiber、服务、渠道与监听地址
 *
 * doctor 默认用系统分配的临时端口（--port 0），不会抢占正在运行的服务；
 * 要按清单端口起服务请用 qm serve。
 */
import path from 'node:path'
import { FiberState } from 'cordis'
import type { Fiber } from 'cordis'
import { listenerCount } from '@qingmei/core'
import {
  DEFAULT_CONFIG,
  failureReason,
  isEntrypoint,
  listChannels,
  listServices,
  parseOptions,
  serve,
  startApp,
  stateName,
} from './index.ts'
import type { App, CliOptions } from './index.ts'

const USAGE = `青梅 P1 命令行

用法：
  qm serve  [--config <path>] [--port <n>] [--host <addr>]   启动服务（等价于 node apps/server/src/index.ts）
  qm doctor [--config <path>] [--port <n>] [--host <addr>]   体检：插件 fiber / 服务 / 渠道（默认临时端口）
  qm help                                                     显示本帮助

默认插件清单：${DEFAULT_CONFIG}
`

/** 组合根要求的最低服务集合；缺任何一个业务插件都跑不起来 */
const REQUIRED_SERVICES = ['store', 'llm', 'channel', 'gateway'] as const

interface RuntimeView {
  name?: string
  fibers: Iterable<Fiber>
}

async function doctor(options: CliOptions): Promise<number> {
  const configPath = options.configPath ?? DEFAULT_CONFIG
  // doctor 不该和正在运行的服务抢端口：没有显式 --port 时用 0 让系统分配。
  // tolerate：缺插件/加载失败时也要把现场打印出来，而不是 15 秒后只给一句超时。
  const app = await startApp({
    ...options,
    port: options.port ?? 0,
    tolerate: true,
    // 体检不需要等满启动超时：3 秒还起不来，现场已经足够诊断。
    timeoutMs: 3_000,
  })
  try {
    const problems = diagnose(app)
    const lines = doctorLines(app, configPath)
    lines.push(
      problems.length === 0
        ? '结论：健康'
        : `结论：异常（${problems.length}）\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    )
    console.log(lines.join('\n'))
    return problems.length === 0 ? 0 : 1
  } finally {
    await app.dispose()
  }
}

function doctorLines(app: App, configPath: string): string[] {
  const lines = [
    '',
    '青梅 P1 · doctor',
    `  配置文件  ${path.resolve(configPath)}`,
    `  监听地址  ${app.server?.url ?? '（未加载 host-gateway，无监听地址）'}`,
    `  插件 fiber（${app.plugins.length}，来自清单）`,
  ]

  for (const plugin of app.plugins) {
    const deps = Object.keys(plugin.fiber.inject)
    const self = plugin.fiber.name
    const suffix = [
      self === plugin.name ? '' : `plugin=${self}`,
      deps.length > 0 ? `deps=${deps.join(',')}` : '',
    ]
      .filter(Boolean)
      .join('  ')
    const state = stateName(plugin.fiber.state)
    const reason = plugin.fiber.state === FiberState.FAILED ? `  ${failureReason(plugin.fiber)}` : ''
    lines.push(
      `    ${state.padEnd(9)} uid=${String(plugin.fiber.uid ?? '-').padEnd(4)} ${plugin.name}${suffix ? `  ${suffix}` : ''}${reason}`,
    )
  }

  const configured = new Set(app.plugins.map((plugin) => plugin.fiber.uid))
  const runtimes = [...(app.ctx.registry.values() as Iterable<RuntimeView>)]
  const others: { name: string; state: number; uid: number | null; fiber: Fiber }[] = []
  for (const runtime of runtimes) {
    for (const fiber of runtime.fibers) {
      if (configured.has(fiber.uid)) continue
      others.push({ name: fiber.name, state: fiber.state, uid: fiber.uid, fiber })
    }
  }
  lines.push(`  其它插件 fiber（${others.length}，插件内部自行挂载）`)
  for (const entry of others) {
    const reason = entry.state === FiberState.FAILED ? `  ${failureReason(entry.fiber)}` : ''
    lines.push(
      `    ${stateName(entry.state).padEnd(9)} uid=${String(entry.uid ?? '-').padEnd(4)} ${entry.name}${reason}`,
    )
  }

  const services = listServices(app.ctx)
  lines.push(`  已注册服务（${services.length}）`)
  for (const service of services) {
    lines.push(
      `    ${service.name.padEnd(9)} ← ${service.impl.padEnd(12)} @ ${service.owner} (${service.ownerState})`,
    )
  }

  const channels = listChannels(app.ctx)
  lines.push(`  渠道状态（${channels.length}）`)
  for (const channel of channels) {
    lines.push(`    ${channel.id.padEnd(9)} ${channel.online ? 'online' : 'offline'}`)
  }

  const gateway = app.ctx.reflect.get('gateway', false) as { routeCount?: number } | undefined
  lines.push(`  网关路由  ${typeof gateway?.routeCount === 'number' ? gateway.routeCount : '未知'}`)
  return lines
}

function diagnose(app: App): string[] {
  const problems: string[] = []
  const services = new Set(listServices(app.ctx).map((service) => service.name))

  for (const plugin of app.plugins) {
    if (plugin.fiber.state === FiberState.ACTIVE) continue
    const deps = Object.keys(plugin.fiber.inject ?? {})
    const missing = deps.filter((dep) => !services.has(dep))
    const detail = missing.length > 0 ? `（缺少 ${missing.join(',')}）` : ''
    const reason = plugin.fiber.state === FiberState.FAILED ? `：${failureReason(plugin.fiber)}` : ''
    problems.push(`插件 ${plugin.name} 处于 ${stateName(plugin.fiber.state)}${detail}${reason}`)
  }

  for (const name of REQUIRED_SERVICES) {
    if (!services.has(name)) problems.push(`缺少服务 "${name}"：请检查清单里对应的提供方`)
  }

  // 没有消费者时，消息会被静默丢弃：HTTP 200 但永远没有回复。
  const consumers = listenerCount(app.ctx, 'qm/inbound')
  if (consumers === 0) {
    problems.push('没有插件消费 qm/inbound：入站消息会石沉大海（缺 qm-agent？）')
  }

  // 插件内部自己挂载的 fiber 失败时，父插件可能仍是 ACTIVE（例如 echo 里的 EchoLlm）。
  const configured = new Set(app.plugins.map((plugin) => plugin.fiber.uid))
  for (const runtime of app.ctx.registry.values() as Iterable<RuntimeView>) {
    for (const fiber of runtime.fibers) {
      if (fiber.state !== FiberState.FAILED || configured.has(fiber.uid)) continue
      problems.push(`插件 fiber ${fiber.name} 处于 FAILED（${failureReason(fiber)}）`)
    }
  }

  for (const channel of listChannels(app.ctx)) {
    if (!channel.online) problems.push(`渠道 ${channel.id} 不在线`)
  }

  // 不按包名判断宿主：只要有 gateway 服务却没监听地址，就是装配问题。
  if (services.has('gateway') && !app.server) {
    problems.push('gateway 服务已注册，但没有宿主在监听（host-gateway 未加载或 FAILED）')
  }

  return problems
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return command === undefined ? 1 : 0
  }

  let options: CliOptions
  try {
    options = parseOptions(rest)
  } catch (error) {
    console.error(`[qm] ${messageOf(error)}\n`)
    console.error(USAGE)
    return 1
  }

  if (command === 'serve') {
    await serve(options)
    return 0
  }
  if (command === 'doctor') {
    return doctor(options)
  }

  console.error(`[qm] 未知命令：${command}\n`)
  console.error(USAGE)
  return 1
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      console.error(`[qm] 执行失败：${messageOf(error)}`)
      process.exitCode = 1
    },
  )
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}
