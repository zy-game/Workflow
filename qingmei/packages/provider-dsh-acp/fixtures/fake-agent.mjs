/**
 * 测试替身：一个最小的 ACP agent（stdio JSON-RPC）。
 *
 * 模式（env FAKE_MODE）：
 *   permission — 先发 session/request_permission，把客户端的选择回显成文本
 *   fs         — 发 fs/write_text_file + fs/read_text_file，回显写进去的内容
 *   escape     — 读会话目录外的路径，把客户端的错误回显出来
 *   terminal   — terminal/create + wait_for_exit + terminal/output
 */
import readline from 'node:readline'

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const rl = readline.createInterface({ input: process.stdin })
const mode = process.env.FAKE_MODE ?? ''
let pendingPrompt = null
let state = {}

function chunk(text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  })
}

function finish() {
  send({
    jsonrpc: '2.0',
    id: pendingPrompt,
    result: { stopReason: 'end_turn', usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 } },
  })
  pendingPrompt = null
  state = {}
}

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message

  // 客户端对请求的回复
  if (message.result !== undefined || message.error !== undefined) {
    if (id === 900) {
      const outcome = message.result?.outcome ?? {}
      chunk(outcome.outcome === 'selected' ? `perm:selected:${outcome.optionId}` : 'perm:cancelled')
      finish()
      return
    }
    if (id === 901 && state.step === 'write') {
      state.step = 'read'
      send({ jsonrpc: '2.0', id: 902, method: 'fs/read_text_file', params: { sessionId: 'sess-1', path: state.path } })
      return
    }
    if (id === 902) {
      chunk(`fs:${message.result?.content ?? ''}`)
      finish()
      return
    }
    if (id === 903) {
      chunk(`fs-error:${message.error?.message ?? 'no-error'}`)
      finish()
      return
    }
    if (id === 904) {
      if (message.error) {
        chunk(`term-error:${message.error.message}`)
        finish()
        return
      }
      state.terminalId = message.result?.terminalId
      state.step = 'wait'
      send({ jsonrpc: '2.0', id: 905, method: 'terminal/wait_for_exit', params: { terminalId: state.terminalId } })
      return
    }
    if (id === 905) {
      state.step = 'output'
      send({ jsonrpc: '2.0', id: 906, method: 'terminal/output', params: { terminalId: state.terminalId } })
      return
    }
    if (id === 906) {
      const exit = message.result?.exitStatus ?? {}
      chunk(`term:${exit.exitCode}:${(message.result?.output ?? '').trim()}`)
      finish()
      return
    }
    return
  }

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp' } } })
    return
  }
  if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: 'sess-1' } })
    return
  }
  if (method === 'session/prompt') {
    pendingPrompt = id
    if (mode === 'permission') {
      send({
        jsonrpc: '2.0',
        id: 900,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          toolCall: { title: 'bash: npm test' },
          options: [
            { optionId: 'allow-1', name: '允许', kind: 'allow_once' },
            { optionId: 'reject-1', name: '拒绝', kind: 'reject_once' },
          ],
        },
      })
      return
    }
    if (mode === 'fs') {
      state = { step: 'write', path: 'notes/hello.txt' }
      send({
        jsonrpc: '2.0',
        id: 901,
        method: 'fs/write_text_file',
        params: { sessionId: 'sess-1', path: state.path, content: '你好，青梅' },
      })
      return
    }
    if (mode === 'escape') {
      state = { step: 'escape' }
      send({ jsonrpc: '2.0', id: 903, method: 'fs/read_text_file', params: { sessionId: 'sess-1', path: '../../etc/passwd' } })
      return
    }
    if (mode === 'terminal') {
      state = { step: 'create' }
      send({
        jsonrpc: '2.0',
        id: 904,
        method: 'terminal/create',
        params: {
          sessionId: 'sess-1',
          command: process.execPath,
          args: ['-e', 'console.log("term-ok")'],
          outputByteLimit: 4096,
        },
      })
      return
    }
    for (const text of ['你', '好']) chunk(text)
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call', title: 'read_file', status: 'completed' } },
    })
    finish()
    return
  }
  if (method === 'session/close') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
})
