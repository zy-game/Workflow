/**
 * 测试替身：一个最小的 ACP agent（stdio JSON-RPC）。
 * 只实现 initialize / session/new / session/prompt / session/close。
 */
import readline from 'node:readline'

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const rl = readline.createInterface({ input: process.stdin })

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp' } } })
    return
  }
  if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: 'sess-1' } })
    return
  }
  if (method === 'session/prompt') {
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
