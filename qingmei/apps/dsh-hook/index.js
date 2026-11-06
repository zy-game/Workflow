/**
 * DSH session hook: 把手工打开的 DSH 会话按轮次送到本机 worker。
 * worker 再负责落盘 / 上报青梅。插件不依赖 MCP。
 */
export const name = 'qingmei-hook'

export function apply(ctx, config = {}) {
  const endpoint = String(config.endpoint || 'http://127.0.0.1:7431/session/ingest')
  const buffers = new Map()

  const bufferFor = (session) => {
    const id = String(session?.id ?? 'unknown')
    let state = buffers.get(id)
    if (!state) {
      state = { id, turns: [], events: [] }
      buffers.set(id, state)
    }
    return state
  }

  const flush = async (state) => {
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.id,
          summary: state.turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.text).join('\n').slice(0, 12000),
          turns: state.turns.slice(-100),
          facts: [],
          lessons: [],
        }),
      })
    } catch {
      // worker 不在线时静默；下一轮/下次关闭会再试
    }
  }

  ctx.on('session/event', (session, event) => {
    const state = bufferFor(session)
    if (event.type === 'user/message') {
      const data = event.data
      state.turns.push({ role: 'user', text: JSON.stringify(data).slice(0, 2000), at: event.time })
    } else if (event.type === 'assistant/message') {
      const data = event.data
      state.turns.push({ role: 'assistant', text: JSON.stringify(data).slice(0, 4000), at: event.time })
    } else if (event.type === 'tool/result') {
      state.turns.push({ role: 'tool', text: JSON.stringify(event.data).slice(0, 2000), at: event.time })
    } else if (event.type === 'turn/end') {
      void flush(state)
    }
  })

  ctx.on('session/disposed', (session) => {
    const state = buffers.get(String(session?.id ?? ''))
    if (state) {
      void flush(state)
      buffers.delete(state.id)
    }
  })
}