/**
 * 测试替身：一个最小的 ACP agent（stdio JSON-RPC）。
 * 实现 initialize / session/new / session/prompt / session/close；
 * 设 FAKE_PERMISSION=1 时，prompt 里会先发一条 session/request_permission，
 * 把客户端的选择作为文本回显（perm:selected:<optionId> / perm:cancelled）。
 */
import readline from 'node:readline'

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const rl = readline.createInterface({ input: process.stdin })
let pendingPrompt = null

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message

  // 客户端对权限请求的回复
  if (id === 900 && message.result !== undefined && pendingPrompt !== null) {
    const outcome = message.result.outcome ?? {}
    const text = outcome.outcome === 'selected' ? `perm:selected:${outcome.optionId}` : 'perm:cancelled'
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    })
    send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'end_turn' } })
    pendingPrompt = null
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
    if (process.env.FAKE_PERMISSION === '1') {
      pendingPrompt = id
      send({
        jsonrpc: '2.0',
        id: 900,
        method: 'session/request_permission',
        params: {
          sessionId: params.sessionId,
          toolCall: { title: 'bash: npm test' },
          options: [
            { optionId: 'allow-1', name: '允许', kind: 'allow_once' },
            { optionId: 'reject-1', name: '拒绝', kind: 'reject_once' },
          ],
        },
      })
      return
    }
    for (const text of ['你', '好']) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        },
      })
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', title: 'read_file', status: 'completed' } } })
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }
  if (method === 'session/close') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
})
