#!/usr/bin/env node
/**
 * 本机 harness worker。
 *
 * 在用户电脑上运行：注册设备（平台/架构/可用 harness），轮询青梅任务，
 * 领取后用本机 dsh --profile acp 执行，
 * 通过 HTTP 回传进度与结果。
 *
 * 用法：
 *   node scripts/harness-worker.mjs --server https://139.155.78.241:8710 --token <QM_TOKEN>
 * 配置默认写到 ~/.qingmei/worker.json；也可用 --config 指定。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
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
    harness: 'dsh',
    dshCommand: String(args['dsh-command'] ?? stored.dshCommand ?? 'dsh'),
    workdir: path.resolve(args.workdir ?? stored.workdir ?? path.join(ROOT, 'workspaces')),
    localPort: Number(args.port ?? stored.localPort ?? 7431),
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
  if (which(String(config.dshCommand).split(/\s+/)[0])) items.push({ kind: 'dsh', acp: true, mcp: false })
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
  const command = config.dshCommand
  if (!command) throw new Error('没有配置 dsh ACP 命令')
  const [executable, ...args] = command.split(/\s+/)
  const cwd = task.target?.cwd ? path.resolve(task.target.cwd) : config.workdir
  mkdirSync(cwd, { recursive: true })
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
    shell: process.platform === 'win32',
    onStderr: (text) => console.error('[dsh] ' + text),
    env: { ...process.env },
    onPermissionRequest: async (event) => {
      const option = event.options?.find((item) => item.kind === 'allow_once' || item.kind === 'allow_always')
      return option?.optionId ?? null
    },
  })
  try {
    await client.start()
    const sessionId = await client.newSession(cwd, [])
    const result = await client.prompt(sessionId, task.prompt)
    await client.closeSession(sessionId).catch(() => undefined)
    return { result: output.trim() || `ACP 完成：${result.stopReason}`, usage: result.usage ?? null }
  } finally {
    client.stop()
  }
}

const sessions = new Map()

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  if (!body) return {}
  return JSON.parse(body)
}

function sessionCommand(config) {
  if (!config.dshCommand) throw new Error('没有配置 dsh ACP 命令')
  return config.dshCommand.split(/\s+/)
}

async function createAcpSession(config, input) {
  const harness = 'dsh'
  const [executable, ...args] = sessionCommand(config)
  const cwd = path.resolve(input.cwd || path.join(config.workdir, `session-${Date.now().toString(36)}`))
  mkdirSync(cwd, { recursive: true })
  const id = `sess_${Math.random().toString(36).slice(2, 10)}`
  const state = { id, harness, cwd, config, client: null, acpSessionId: null, turns: [], events: [], output: '', stream: null }
  const client = new AcpClient({
    command: executable,
    args: args.length > 0 ? args : ['--profile', 'acp'],
    cwd,
    shell: process.platform === 'win32',
    env: { ...process.env },
    onUpdate: (event) => {
      state.events.push(event)
      const update = event.update ?? {}
      if (String(update.sessionUpdate ?? '') === 'agent_message_chunk') {
        const content = update.content
        if (content && typeof content === 'object' && content.type === 'text') {
          state.output += content.text ?? ''
          if (state.stream) state.stream.write('data: ' + JSON.stringify({ text: content.text ?? '' }) + '\\n\\n')
        }
      }
    },
    onPermissionRequest: async (event) => {
      const option = event.options?.find((item) => item.kind === 'allow_once' || item.kind === 'allow_always')
      return option?.optionId ?? null
    },
  })
  await client.start()
  state.client = client
  state.acpSessionId = await client.newSession(cwd, [])
  sessions.set(id, state)
  return state
}

async function memoryContext(config, text) {
  try {
    const result = await request(config, 'POST', '/api/v1/devices/context', {
      deviceId: config.deviceId,
      text,
      limit: 5,
    })
    return typeof result?.text === 'string' ? result.text.trim() : ''
  } catch {
    return ''
  }
}
async function promptSession(state, text) {
  state.turns.push({ role: 'user', text, at: Date.now() })
  const context = await memoryContext(state.config, text)
  const prompt = context ? '【青梅记忆】\\n' + context + '\\n\\n【用户】\\n' + text : text
  state.output = ''
  const result = await state.client.prompt(state.acpSessionId, prompt)
  const output = state.output.trim()
  state.turns.push({ role: 'assistant', text: output, at: Date.now() })
  return { output, stopReason: result.stopReason, turns: state.turns, events: state.events.slice(-50) }
}

function startLocalServer(config) {
  const port = Number(config.localPort)
  if (!Number.isFinite(port) || port <= 0) return
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'POST' && url.pathname === '/session/new') {
        const input = await readJsonBody(req)
        const state = await createAcpSession(config, input)
        sendJson(res, 200, { ok: true, sessionId: state.id, cwd: state.cwd, harness: state.harness })
        return
      }
      if (req.method === 'POST' && url.pathname === '/session/prompt') {
        const input = await readJsonBody(req)
        const state = sessions.get(String(input.sessionId ?? ''))
        if (!state) return sendJson(res, 404, { ok: false, error: '没有这个会话' })
        if (input.stream === true) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          state.stream = res
          try {
            const result = await promptSession(state, String(input.text ?? ''))
            res.write('event: done\ndata: ' + JSON.stringify(result) + '\n\n')
          } catch (error) {
            res.write('event: error\ndata: ' + JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n\n')
          } finally {
            state.stream = null
            res.end()
          }
          return
        }
        const result = await promptSession(state, String(input.text ?? ''))
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (req.method === 'GET' && url.pathname === '/session/state') {
        const state = sessions.get(String(url.searchParams.get('sessionId') ?? ''))
        if (!state) return sendJson(res, 404, { ok: false, error: '没有这个会话' })
        sendJson(res, 200, { ok: true, sessionId: state.id, harness: state.harness, cwd: state.cwd, turns: state.turns, events: state.events.slice(-50) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/session/cancel') {
        const input = await readJsonBody(req)
        const state = sessions.get(String(input.sessionId ?? ''))
        if (!state) return sendJson(res, 404, { ok: false, error: '没有这个会话' })
        state.client.cancel(state.acpSessionId)
        sendJson(res, 200, { ok: true })
        return
      }      if (req.method === 'POST' && url.pathname === '/session/close') {
        const input = await readJsonBody(req)
        const state = sessions.get(String(input.sessionId ?? ''))
        if (!state) return sendJson(res, 404, { ok: false, error: '没有这个会话' })
        await state.client.closeSession(state.acpSessionId).catch(() => undefined)
        state.client.stop()
        await request(config, 'POST', '/api/v1/devices/ingest', {
          deviceId: config.deviceId,
          sessionId: state.id,
          summary: state.turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.text).join('\\n'),
          turns: state.turns,
          facts: [],
          lessons: [],
        }).catch(() => undefined)
        sessions.delete(state.id)
        sendJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'POST' && url.pathname === '/session/ingest') {
        const input = await readJsonBody(req)
        const dir = path.join(ROOT, 'sessions')
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, `${String(input.sessionId ?? 'unknown')}.json`), JSON.stringify(input, null, 2), 'utf8')
        const remote = await request(config, 'POST', '/api/v1/devices/ingest', { ...input, deviceId: config.deviceId })
        sendJson(res, 200, { ok: true, remote: Boolean(remote) })
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
  server.listen(port, '127.0.0.1', () => console.log(`[worker] 本地会话 API：http://127.0.0.1:${port}`))
  server.unref?.()
}
async function main() {
  const config = loadConfig(parseArgs(process.argv.slice(2)))
  const caps = capabilities(config)
  if (caps.length === 0) throw new Error('本机没有检测到可用的 dsh')
  const registered = await request(config, 'POST', '/api/v1/devices/register', {
    id: config.deviceId,
    name: config.name,
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
    harnesses: caps,
    workspaces: Array.isArray(config.workspaces) && config.workspaces.length > 0
      ? config.workspaces
      : [{ id: 'workdir', title: path.basename(config.workdir), path: config.workdir }],
    workerVersion: '0.1.0',
  })
  console.log(`[worker] 已注册：${registered.device.id} (${registered.device.platform}/${registered.device.arch})`)
  console.log(`[worker] harness：${caps.map((item) => `${item.kind}(acp=${item.acp})`).join('、')}`)
  startLocalServer(config)
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
        workspaces: Array.isArray(config.workspaces) && config.workspaces.length > 0
          ? config.workspaces
          : [{ id: 'workdir', title: path.basename(config.workdir), path: config.workdir }],
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
        note: `${task.target?.executorId ?? 'executor'} 已启动`,
      }).catch(() => undefined)
      try {
        const result = await runDsh(config, task)
        const failed = /Request failed:|model_request_failed|Turn execution failed|Network error, retrying/i.test(result.result)
        await request(config, 'POST', '/api/v1/devices/finish', {
          taskId: task.id,
          status: failed ? 'failed' : 'done',
          ...(failed ? { error: result.result } : { result: result.result }),
        })
        console.log(`${failed ? '[worker] 任务失败' : '[worker] 任务完成'} ${task.id}`)
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
