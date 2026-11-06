/**
 * ZCode Stop hook: 从 stdin 读取会话结束事件，转成 worker ingest。
 * 不依赖 MCP；ZCode 手动会话由 ZCode 自己在 Stop 时触发。
 */
import { readFileSync } from 'node:fs'

const endpoint = process.env.QM_WORKER_INGEST || 'http://127.0.0.1:7431/session/ingest'
let input = {}
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  input = {}
}

const rawMessages = Array.isArray(input.messages) ? input.messages : Array.isArray(input.transcript) ? input.transcript : []
const turns = rawMessages.slice(-100).map((item) => {
  const role = String(item.role ?? item.type ?? 'assistant')
  const text = typeof item.text === 'string' ? item.text : typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? '')
  return { role: role === 'user' ? 'user' : role === 'tool' ? 'tool' : 'assistant', text: text.slice(0, 4000), at: Date.now() }
})
const summary = turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.text).join('\n').slice(0, 12000)
const sessionId = String(input.session_id ?? input.sessionId ?? input.id ?? `zcode-${Date.now().toString(36)}`)

try {
  await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, cwd: input.cwd ?? process.cwd(), summary, turns, facts: [], lessons: [] }),
  })
} catch {
  // worker 不在线时静默；ZCode 不因 hook 失败而阻塞
}