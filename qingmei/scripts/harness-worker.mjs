#!/usr/bin/env node
/**
 * 本机 harness worker。
 *
 * 在用户电脑上运行：注册设备（平台/架构/可用 harness），轮询青梅任务，
 * 领取后用本机 dsh --profile acp（或配置的 ZCode ACP bridge）执行，
 * 通过 HTTP 回传进度与结果。
 *
 * 用法：
 *   node scripts/harness-worker.mjs --server https://139.155.78.241:8710 --token <QM_TOKEN>
 * 配置默认写到 ~/.qingmei/worker.json；也可用 --config 指定。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { AcpClient } from '../packages/provider-dsh-acp/src/acp-client.ts'

const ROOT = path.join(homedir(), '.qingmei')
const DEFAULT_CONFIG = path.join(ROOT, 'worker.json')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    args[key.slice(2)] = argv[i + 1]
    i += 1
  }
  return args
}

function loadConfig(args) {
  const file = path.resolve(args.config ?? DEFAULT_CONFIG)
  let stored = {}
  if (existsSync(file)) stored = JSON.parse(readFileSync(file, 'utf8'))
  const config = {
    server: String(args.server ?? stored.server ?? 'https://139.155.78.241:8710').replace(/\/+$/, ''),
    token: String(args.token ?? stored.token ?? ''),
    name: String(args.name ?? stored.name ?? `${hostname()} (Windows)`),
    deviceId: String(args['device-id'] ?? stored.deviceId ?? ''),
    harness: String(args.harness ?? stored.harness ?? 'dsh'),
    dshCommand: String(args['dsh-command'] ?? stored.dshCommand ?? 'dsh'),
    zcodeAcpCommand: String(args['zcode-acp-command'] ?? stored.zcodeAcpCommand ?? ''),
    mcpUrl: String(args['mcp-url'] ?? stored.mcpUrl ?? ''),
    mcpToken: String(args['mcp-token'] ?? stored.mcpToken ?? ''),
    workdir: path.resolve(args.workdir ?? stored.workdir ?? path.join(ROOT, 'workspaces')),
  }
  if (!config.token) throw new Error('缺少 QM_TOKEN：用 --token 或配置 token')
  if (!config.deviceId) config.deviceId = `dev-${hostname().replace(/[^a-zA-Z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
  return config
}

function which(command) {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8' })
    return result.status === 0
  } catch {
    return false
  }
}

function capabilities(config) {
  const items = []
  if (which(String(config.dshCommand).split(/\\s+/)[0])) items.push({ kind: 'dsh', acp: true, mcp: Boolean(config.mcpUrl) })
  if (config.zcodeAcpCommand && which(config.zcodeAcpCommand.split(/\s+/)[0])) {
    items.push({ kind: 'zcode', acp: true, mcp: Boolean(config.mcpUrl) })
  }
  return items
}

async function request(config, method, pathname, body) {
  const response = await fetch(`${config.server}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const detail = await response.json().catch(() => null)
  if (!response.ok) throw new Error(detail?.error || `${method} ${pathname} HTTP ${response.status}`)
  return detail
}

async function runDsh(config, task) {
  const command = task.harness === 'zcode' ? config.zcodeAcpCommand : config.dshCommand
  if (!command) throw new Error(`没有配置 ${task.harness} 的 ACP 命令`)
  const [executable, ...args] = command.split(/\s+/)
  const cwd = path.join(config.workdir, task.id.replace(/[^a-zA-Z0-9_-]/g, '_'))
  mkdirSync(cwd, { recursive: true })
  const mcpServers = config.mcpUrl
    ? [{ type: 'http', name: 'qingmei', url: config.mcpUrl, ...(config.mcpToken ? { headers: { Authorization: `Bearer ${config.mcpToken}` } } : {}) }]
    : []
  let output = ''
  const client = new AcpClient({
    command: executable,
    args: args.length > 0 ? args : ['--profile', 'acp'],
    cwd,
    onUpdate: (event) => {
      const update = event.update ?? {}
      const kind = String(update.sessionUpdate ?? '')
      if (kind === 'agent_message_chunk') {
        const content = update.content
        if (content && typeof content === 'object' && content.type === 'text') output += content.text ?? ''
      }
    },
    onPermissionRequest: async (event) => {
      const option = event.options?.find((item) => item.kind === 'allow_once' || item.kind === 'allow_always')
      return option?.optionId ?? null
    },
  })
  try {
    await client.start()
    const sessionId = await client.newSession(cwd, mcpServers)
    const result = await client.prompt(sessionId, task.prompt)
    await client.closeSession(sessionId).catch(() => undefined)
    return { result: output.trim() || `ACP 完成：${result.stopReason}`, usage: result.usage ?? null }
  } finally {
    client.stop()
  }
}

async function main() {
  const config = loadConfig(parseArgs(process.argv.slice(2)))
  const caps = capabilities(config)
  if (caps.length === 0) throw new Error('本机没有检测到可用的 dsh/zcode')
  const registered = await request(config, 'POST', '/api/v1/devices/register', {
    id: config.deviceId,
    name: config.name,
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
    harnesses: caps,
    workerVersion: '0.1.0',
  })
  console.log(`[worker] 已注册：${registered.device.id} (${registered.device.platform}/${registered.device.arch})`)
  console.log(`[worker] harness：${caps.map((item) => `${item.kind}(acp=${item.acp})`).join('、')}`)
  let running = true
  process.on('SIGINT', () => {
    running = false
  })
  while (running) {
    try {
      await request(config, 'POST', '/api/v1/devices/heartbeat', {
        id: config.deviceId,
        platform: process.platform,
        arch: process.arch,
        harnesses: caps,
        workerVersion: '0.1.0',
      })
      const claimed = await request(config, 'POST', '/api/v1/devices/claim', { deviceId: config.deviceId })
      const task = claimed.task
      if (!task) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        continue
      }
      console.log(`[worker] 领取任务 ${task.id}：${task.title}`)
      await request(config, 'POST', '/api/v1/devices/progress', {
        taskId: task.id,
        phase: 'running',
        percent: 10,
        note: `${task.harness} 已启动`,
      }).catch(() => undefined)
      try {
        const result = await runDsh(config, task)
        await request(config, 'POST', '/api/v1/devices/finish', {
          taskId: task.id,
          status: 'done',
          result: result.result,
        })
        console.log(`[worker] 任务完成 ${task.id}`)
      } catch (error) {
        await request(config, 'POST', '/api/v1/devices/finish', {
          taskId: task.id,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        console.error(`[worker] 任务失败 ${task.id}`, error)
      }
    } catch (error) {
      console.error('[worker] 轮询失败', error instanceof Error ? error.message : error)
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }
}

main().catch((error) => {
  console.error('[worker] 启动失败', error)
  process.exitCode = 1
})
