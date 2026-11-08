#!/usr/bin/env node
/**
 * 青梅 P1 端到端冒烟。
 *
 * 只依赖 Node 内置模块（child_process / fetch / net），流程与人工验收一致：
 *   1. 用非默认端口启动服务，等 /healthz 返回 200
 *   2. 带 Bearer token POST /api/v1/messages 发一句「你好」
 *   3. 轮询 GET /api/v1/messages，确认 user / assistant 两条已落库
 *   4. 关掉服务、重启，再读同一会话，确认历史还在
 *
 * 用法（在仓库根目录）：
 *   node scripts/smoke.mjs
 *   QM_SMOKE_PORT=17411 node scripts/smoke.mjs
 *   QM_TOKEN=xxx node scripts/smoke.mjs        # 清单里的 token 改过时
 *
 * 退出码：0 = 全绿，1 = 有失败。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = process.env.QM_TOKEN ?? 'dev-token'
const CONVERSATION_ID = `smoke-${Date.now().toString(36)}`
const AUTH = { authorization: `Bearer ${TOKEN}` }
const WAIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100

const expectedExits = new WeakSet()
let currentChild = null

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function log(step, detail) {
  console.log(`✔ ${step}${detail === undefined ? '' : ` — ${detail}`}`)
}

async function freePort() {
  if (process.env.QM_SMOKE_PORT) return Number(process.env.QM_SMOKE_PORT)
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function startServer(label) {
  const child = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'apps/server/src/index.ts'), '--port', String(PORT)],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  )
  child.on('exit', (code, signal) => {
    if (!expectedExits.has(child)) {
      console.error(`✘ 服务意外退出（${label}）code=${code} signal=${signal}`)
      process.exitCode = 1
    }
  })
  currentChild = child
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  expectedExits.add(child)
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await Promise.race([exited, delay(5000)])
  // Windows 上被 kill 的进程 exitCode 为 null、signalCode 为 SIGTERM，两个都要看。
  if (child.exitCode === null && child.signalCode === null) {
    console.warn('[smoke] 服务 5s 内未退出，继续流程')
  }
}

async function request(pathname, init = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, text, json }
}

async function waitForHealth(label) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  let lastError = '尚未请求'
  while (Date.now() < deadline) {
    try {
      const response = await request('/healthz')
      if (response.status === 200) {
        log(`${label}：/healthz 返回 200`, JSON.stringify(response.json))
        return response.json
      }
      lastError = `HTTP ${response.status} ${response.text}`
    } catch (error) {
      lastError = error.message
    }
    await delay(200)
  }
  throw new Error(`等待 ${BASE}/healthz 超时（最后错误：${lastError}）`)
}

async function readHistory(conversationId) {
  const response = await request(
    `/api/v1/messages?conversationId=${encodeURIComponent(conversationId)}&limit=50`,
    { headers: AUTH },
  )
  assert.equal(response.status, 200, `GET /api/v1/messages 应为 200，实际 ${response.status}: ${response.text}`)
  assert.ok(Array.isArray(response.json), '历史接口应返回数组')
  return response.json
}

async function waitForTurn(conversationId) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  let rows = []
  while (Date.now() < deadline) {
    rows = await readHistory(conversationId)
    const hasUser = rows.some((row) => row.role === 'user')
    const hasAssistant = rows.some((row) => row.role === 'assistant')
    if (hasUser && hasAssistant) return rows
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error(`等待助手回复超时，当前历史：${JSON.stringify(rows)}`)
}

let PORT = 0
let BASE = ''

async function main() {
  PORT = await freePort()
  BASE = `http://127.0.0.1:${PORT}`
  console.log(`\n[smoke] 仓库：${REPO_ROOT}`)
  console.log(`[smoke] 地址：${BASE}  会话：${CONVERSATION_ID}\n`)

  const first = startServer('第一次启动')
  let rows
  try {
    const health = await waitForHealth('第一次启动')
    assert.equal(health.ok, true, 'healthz.ok 应为 true')
    assert.ok(
      Array.isArray(health.channels) && health.channels.some((channel) => channel.id === 'web' && channel.online),
      'healthz.channels 应包含在线的 web 渠道',
    )

    const unauthorized = await request(`/api/v1/messages?conversationId=${CONVERSATION_ID}`)
    assert.equal(unauthorized.status, 401, '无 token 的 /api/v1/* 应为 401')
    log('无 token 请求被拒', `HTTP ${unauthorized.status}`)

    const posted = await request('/api/v1/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好', conversationId: CONVERSATION_ID }),
    })
    assert.equal(posted.status, 200, `POST /api/v1/messages 应为 200，实际 ${posted.status}: ${posted.text}`)
    assert.equal(posted.json?.ok, true, 'POST 响应 ok 应为 true')
    log('POST /api/v1/messages', `HTTP ${posted.status} platformMessageId=${posted.json.platformMessageId}`)

    rows = await waitForTurn(CONVERSATION_ID)
    assert.equal(rows.length, 2, `本会话应只有 user/assistant 两条，实际 ${rows.length}`)
    assert.deepEqual(
      rows.map((row) => row.role),
      ['user', 'assistant'],
    )
    const [user, assistant] = rows
    assert.equal(user.text, '你好', 'user 消息内容应为「你好」')
    assert.ok(typeof assistant.text === 'string' && assistant.text.includes('你好'), 'assistant 回复应包含用户输入')
    assert.ok(assistant.id !== user.id, 'user / assistant 的 id 应不同')
    log('历史已落库（第一次）', `${user.role}="${user.text}" / ${assistant.role}="${assistant.text}"`)

    const deviceId = `dev-smoke-${Date.now().toString(36)}`
    const workspaceId = `ws-smoke-${Date.now().toString(36)}`
    const register = await request('/api/v1/devices/register', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: deviceId,
        name: 'smoke device',
        platform: 'windows',
        arch: 'x64',
        hostname: 'smoke',
        harnesses: [{ kind: 'dsh', acp: true }],
        workspaces: [{ id: workspaceId, title: 'Smoke', path: REPO_ROOT }],
      }),
    })
    assert.equal(register.status, 200, `注册设备失败：${register.status} ${register.text}`)
    assert.equal(register.json?.device?.deviceClass, 'desktop', '设备类型应由平台派生')

    const enqueued = await request('/api/v1/devices/tasks', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        harness: 'dsh',
        workspaceId,
        threadId: 'smoke-thread',
        title: 'Smoke task',
        prompt: '只回复 SMOKE_TASK',
      }),
    })
    assert.equal(enqueued.status, 201, `派发设备任务失败：${enqueued.status} ${enqueued.text}`)
    const taskId = enqueued.json?.task?.id
    assert.ok(taskId, '设备任务应有 id')
    assert.deepEqual(enqueued.json.task.target, {
      deviceId,
      workspaceId,
      harnessId: 'dsh',
      cwd: REPO_ROOT,
    })
    log('设备任务已入队', taskId)

    const claimed = await request('/api/v1/devices/claim', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, harness: 'dsh' }),
    })
    assert.equal(claimed.status, 200)
    assert.equal(claimed.json?.task?.id, taskId)
    assert.equal(claimed.json?.task?.target?.workspaceId, workspaceId)

    const finished = await request('/api/v1/devices/finish', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, status: 'done', result: 'SMOKE_TASK', sessionId: 'session-smoke' }),
    })
    assert.equal(finished.status, 200)
    const tasks = await request(`/api/v1/devices/tasks?deviceId=${encodeURIComponent(deviceId)}`, { headers: AUTH })
    assert.equal(tasks.status, 200)
    assert.equal(tasks.json?.items?.[0]?.status, 'done')
    assert.equal(tasks.json?.items?.[0]?.sessionId, 'session-smoke')
    assert.equal(tasks.json?.items?.[0]?.target?.sessionId, 'session-smoke')
    log('设备任务 claim/finish/session 持久化通过')

    const approval = await request('/api/v1/approvals', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'smoke:approval', prompt: 'smoke approval', requester: 'smoke' }),
    })
    assert.equal(approval.status, 201, `创建审批失败：${approval.status} ${approval.text}`)
    const approvalId = approval.json?.item?.id
    assert.ok(approvalId)
    const decided = await request('/api/v1/approvals/decide', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ id: approvalId, allow: true }),
    })
    assert.equal(decided.status, 200)
    assert.equal(decided.json?.request?.status, 'allowed')
    log('审批创建/决定通过')
  } finally {
    await stopServer(first)
  }
  log('服务已关闭')

  const second = startServer('第二次启动')
  let reloaded
  try {
    await waitForHealth('第二次启动')
    reloaded = await readHistory(CONVERSATION_ID)
    assert.deepEqual(
      reloaded.map((row) => row.id),
      rows.map((row) => row.id),
      '重启后应读回同样的两条记录',
    )
    assert.deepEqual(
      reloaded.map((row) => [row.role, row.text]),
      rows.map((row) => [row.role, row.text]),
      '重启后消息内容应与关闭前一致',
    )
    log('重启后历史仍在', reloaded.map((row) => `${row.role}="${row.text}"`).join(' / '))
  } finally {
    await stopServer(second)
  }

  console.log('\nSMOKE PASS：healthz → 发消息 → 落库 → 重启持久化，全部通过。')
  return 0
}

const cleanup = () => {
  if (currentChild && currentChild.exitCode === null) {
    expectedExits.add(currentChild)
    currentChild.kill()
  }
}
process.once('SIGINT', () => {
  cleanup()
  process.exit(130)
})
process.once('SIGTERM', () => {
  cleanup()
  process.exit(143)
})

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(`\nSMOKE FAIL：${error instanceof Error ? error.message : String(error)}`)
    console.error(error)
    cleanup()
    process.exitCode = 1
    // 让 stdio inherit 的子进程日志先输出完
    setTimeout(() => process.exit(1), 100)
  },
)
