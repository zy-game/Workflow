/**
 * ACP 最小验证脚本（不是产品代码）。
 *
 * 用途：确认 `dsh --profile acp` 能握手、建会话、流式返回一条真实模型回复。
 * 产品实现见 packages/provider-dsh-acp；本脚本用来在服务器上快速回归 DSH 升级。
 *
 * 运行：
 *   QM_DSH_API_KEY=sk-... node scripts/spike-acp.mjs
 */
import { spawn } from 'node:child_process'

const child = spawn('/usr/local/bin/dsh', ['--profile', 'acp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})

let buffer = ''
let seq = 0
const pending = new Map()
const updates = []

child.stderr.on('data', (chunk) => process.stderr.write(`[dsh] ${chunk}`))
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      const message = JSON.parse(line)
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      } else if (message.method === 'session/update') {
        updates.push(message.params)
      }
    }
    index = buffer.indexOf('\n')
  }
})

function request(method, params) {
  const id = ++seq
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 120_000)
  })
}

const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
console.log('INIT:', JSON.stringify(init.result.agentInfo))

const created = await request('session/new', { cwd: process.cwd(), mcpServers: [] })
if (created.error) throw new Error(JSON.stringify(created.error))
const sessionId = created.result.sessionId
console.log('SESSION:', sessionId)

const prompt = await request('session/prompt', {
  sessionId,
  prompt: [{ type: 'text', text: '用一句话说明你能帮我做什么' }],
})
console.log('PROMPT RESULT:', JSON.stringify(prompt.result).slice(0, 200))

const texts = updates
  .filter((u) => u.update?.sessionUpdate === 'agent_message_chunk')
  .map((u) => u.update.content?.text ?? '')
console.log('CHUNKS:', texts.length)
console.log('REPLY:', texts.join('').slice(0, 300))

await request('session/close', { sessionId }).catch(() => {})
child.kill()
