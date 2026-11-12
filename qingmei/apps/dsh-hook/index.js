/**
 * DSH session hook：把手工打开的 DSH 会话按轮次直接送到青梅。
 *
 * 不再经过本机 worker：直接 POST /api/v1/devices/ingest（带 deviceId/token）。
 * 送的是逐轮原文与工具事件，不是一句笼统摘要——摘要由服务端自己凝练。
 */
export const name = 'qingmei-hook'

function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (value.content !== undefined) return textOf(value.content)
  return ''
}

export function apply(ctx, config = {}) {
  const api = String(config.api || '').replace(/\/+$/, '')
  const token = String(config.token || '')
  const deviceId = String(config.deviceId || '')
  const endpoint = String(config.endpoint || '')
  const direct = Boolean(api && token && deviceId)
  const target = direct ? `${api}/api/v1/devices/ingest` : endpoint
  if (!target) return
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
    const summary = state.turns
      .filter((turn) => turn.role === 'assistant')
      .map((turn) => turn.text)
      .join('\n')
      .slice(0, 20_000)
    const body = {
      sessionId: state.id,
      summary,
      turns: state.turns.slice(-200),
      events: state.events.slice(-100),
      facts: [],
      lessons: [],
    }
    try {
      await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(direct ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(direct ? { deviceId, ...body } : body),
      })
    } catch {
      // 目标不在线时静默；下一轮/下次关闭会再试
    }
  }

  ctx.on('session/event', (session, event) => {
    const state = bufferFor(session)
    if (event.type === 'user/message') {
      const text = textOf(event.data)
      if (text) state.turns.push({ role: 'user', text: text.slice(0, 4000), at: event.time })
    } else if (event.type === 'assistant/message') {
      const data = event.data
      const text = textOf(data?.message?.content ?? data?.content ?? data)
      if (text) state.turns.push({ role: 'assistant', text: text.slice(0, 8000), at: event.time })
    } else if (event.type === 'tool/call' || event.type === 'tool/result') {
      state.events.push({ type: event.type, at: event.time, data: event.data })
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
