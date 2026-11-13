import { ENDPOINTS, resolveEndpoint } from './endpoints.js'
import { hasAuth, session, setStatus } from './session.js'
import { emit } from './bus.js'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 10_000

let source = null
let reconnectTimer = 0

export function parseEventData(raw) {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function textOf(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  for (const key of ['text', 'delta', 'content', 'answer', 'reply']) {
    if (typeof value[key] === 'string') return value[key]
  }
  if (value.message) return textOf(value.message)
  if (Array.isArray(value.blocks)) {
    return value.blocks
      .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function eventsUrl() {
  const url = new URL(resolveEndpoint(ENDPOINTS.events), location.href)
  // EventSource 不能带自定义 header，token 只能走 query；网关需同时接受 ?token=
  url.searchParams.set('token', session.token)
  return url.href
}

export function closeEvents() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = 0
  }
  if (source) {
    source.close()
    source = null
  }
}

function scheduleReconnect() {
  if (!hasAuth()) return
  if (source) {
    source.close()
    source = null
  }
  if (reconnectTimer) return
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** session.reconnectAttempt, RECONNECT_MAX_MS)
  session.reconnectAttempt += 1
  setStatus('offline', `已断开，${delay / 1000} 秒后重连…`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0
    connect()
  }, delay)
}

function routeEvent(type, payload) {
  if (!type) return
  if (type === 'chunk') emit('chunk', payload)
  else if (type === 'assistant') emit('assistant', payload)
  else if (type === 'notice') emit('notice', textOf(payload) || '服务端返回错误')
  else emit(type, payload)
}

export function connect() {
  if (!hasAuth()) return
  closeEvents()
  const attempt = session.reconnectAttempt
  setStatus('connecting', attempt > 0 ? `重连中（第 ${attempt} 次）…` : '连接中…')

  let next
  try {
    next = new EventSource(eventsUrl())
  } catch {
    scheduleReconnect()
    return
  }
  source = next

  next.addEventListener('open', () => {
    session.reconnectAttempt = 0
    setStatus('online')
  })

  next.addEventListener('chunk', (event) => routeEvent('chunk', parseEventData(event.data)))
  next.addEventListener('assistant', (event) => routeEvent('assistant', parseEventData(event.data)))

  for (const type of ['task-started', 'task-progress', 'task-finished']) {
    next.addEventListener(type, (event) => routeEvent(type, parseEventData(event.data)))
  }
  for (const type of ['approval-requested', 'approval-decided']) {
    next.addEventListener(type, (event) => routeEvent(type, parseEventData(event.data)))
  }
  for (const type of ['autonomy-tick', 'device-offline']) {
    next.addEventListener(type, (event) => routeEvent(type, parseEventData(event.data)))
  }

  // 兼容把事件类型写在 data.type / data.event 里的服务端实现
  next.addEventListener('message', (event) => {
    const payload = parseEventData(event.data)
    const type = payload && typeof payload === 'object' ? payload.type || payload.event : ''
    if (typeof type === 'string' && type) routeEvent(type, payload)
  })

  next.addEventListener('error', (event) => {
    if (event && typeof event.data === 'string' && event.data) {
      emit('notice', textOf(parseEventData(event.data)) || '事件流返回错误')
      return
    }
    scheduleReconnect()
  })
}

