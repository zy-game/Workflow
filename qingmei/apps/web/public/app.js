// 青梅 Web 客户端（P1）：原生 ES module，零构建、零框架；M0 起迁移 Vue 3（届时本文件被组件替代）。
'use strict'

const TOKEN_KEY = 'qm.token'
const ENDPOINTS = {
  health: './healthz',
  events: './api/v1/events',
  messages: './api/v1/messages',
}
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 10000
const SEND_RETRY_MS = 2000
const HEALTH_TIMEOUT_MS = 4000
const STICK_TO_BOTTOM_PX = 120

const el = {
  messages: document.getElementById('messages'),
  empty: document.getElementById('empty'),
  form: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
}

const state = {
  token: '',
  events: null,
  reconnectAttempt: 0,
  reconnectTimer: 0,
  /** 正在流式写入的助手气泡：{ node, body, text } */
  current: null,
  sending: false,
  failed: false,
  retryAt: 0,
  retryTimer: 0,
}

// ── 令牌 ─────────────────────────────────────

function loadToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

function saveToken(token) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    // 隐私模式禁用存储时，令牌只在本次页面生命周期内有效
  }
}

function readUrlToken() {
  let url
  try {
    url = new URL(location.href)
  } catch {
    return ''
  }
  const token = (url.searchParams.get('token') || '').trim()
  if (!token) return ''
  saveToken(token)
  // 令牌不留在地址栏与历史记录里；刷新时从 sessionStorage 取回
  url.searchParams.delete('token')
  try {
    history.replaceState(history.state, '', url.href)
  } catch {
    // file:// 等环境不允许改历史，忽略即可
  }
  return token
}

function withAuth(headers = {}) {
  const next = { ...headers }
  if (state.token) next.Authorization = `Bearer ${state.token}`
  return next
}

// ── 连接状态 ─────────────────────────────────

const STATUS_TEXT = {
  connecting: '连接中…',
  online: '在线',
  offline: '离线',
  error: '需要令牌',
}

function setStatus(kind, text) {
  el.status.dataset.state = kind
  el.statusText.textContent = text || STATUS_TEXT[kind] || ''
  el.status.title = el.statusText.textContent
}

async function probeHealth() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const res = await fetch(ENDPOINTS.health, {
      headers: withAuth(),
      cache: 'no-store',
      signal: controller.signal,
    })
    if (res.ok) {
      setStatus('online')
      return true
    }
    if (res.status === 401 || res.status === 403) {
      setStatus('error', '令牌无效')
      return false
    }
    setStatus('offline', `服务异常（${res.status}）`)
    return false
  } catch {
    setStatus('offline', '无法连接服务')
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ── 事件流 ───────────────────────────────────

function eventsUrl() {
  const url = new URL(ENDPOINTS.events, location.href)
  // EventSource 不能带自定义 header，token 只能走 query；网关需同时接受 ?token=
  url.searchParams.set('token', state.token)
  return url.href
}

function closeEvents() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = 0
  }
  if (state.events) {
    state.events.close()
    state.events = null
  }
}

function connect() {
  if (!state.token) return
  closeEvents()
  const attempt = state.reconnectAttempt
  setStatus('connecting', attempt > 0 ? `重连中（第 ${attempt} 次）…` : '连接中…')

  let source
  try {
    source = new EventSource(eventsUrl())
  } catch {
    scheduleReconnect()
    return
  }
  state.events = source

  source.addEventListener('open', () => {
    state.reconnectAttempt = 0
    setStatus('online')
  })

  source.addEventListener('chunk', (event) => {
    handleChunk(parseEventData(event.data))
  })

  source.addEventListener('assistant', (event) => {
    handleAssistant(parseEventData(event.data))
  })

  // 兼容把事件类型写在 data.type / data.event 里的服务端实现
  source.addEventListener('message', (event) => {
    const payload = parseEventData(event.data)
    const type = payload && typeof payload === 'object' ? payload.type || payload.event : ''
    if (typeof type === 'string' && type) routeEvent(type, payload)
  })

  source.addEventListener('error', (event) => {
    if (event && typeof event.data === 'string' && event.data) {
      appendNotice(textOf(parseEventData(event.data)) || '事件流返回错误')
      return
    }
    scheduleReconnect()
  })
}

function scheduleReconnect() {
  if (!state.token) return
  if (state.events) {
    state.events.close()
    state.events = null
  }
  if (state.reconnectTimer) return
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** state.reconnectAttempt, RECONNECT_MAX_MS)
  state.reconnectAttempt += 1
  setStatus('offline', `已断开，${delay / 1000} 秒后重连…`)
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = 0
    connect()
  }, delay)
}

function routeEvent(type, payload) {
  if (type === 'chunk') handleChunk(payload)
  else if (type === 'assistant') handleAssistant(payload)
  else if (type === 'error') appendNotice(textOf(payload) || '服务端返回错误')
}

// ── 消息渲染 ─────────────────────────────────

function parseEventData(raw) {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** 从 {text} / {delta} / {message} / Block[] 中取出可直接显示的文本 */
function textOf(value) {
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

function isNearBottom() {
  const box = el.messages
  return box.scrollHeight - box.scrollTop - box.clientHeight < STICK_TO_BOTTOM_PX
}

function stickToBottom(force = false) {
  if (force || isNearBottom()) el.messages.scrollTop = el.messages.scrollHeight
}

function hideEmpty() {
  if (el.empty) el.empty.hidden = true
}

function appendBubble(role) {
  const stick = isNearBottom()
  hideEmpty()
  const node = document.createElement('article')
  node.className = `msg msg-${role}`

  const roleTag = document.createElement('span')
  roleTag.className = 'msg-role'
  roleTag.textContent = role === 'user' ? '你' : '青梅'

  const body = document.createElement('div')
  body.className = 'bubble'

  node.append(roleTag, body)
  el.messages.append(node)
  if (stick || role === 'user') el.messages.scrollTop = el.messages.scrollHeight
  return { node, body }
}

function ensureAssistantBubble() {
  if (state.current) return state.current
  const { node, body } = appendBubble('assistant')
  state.current = { node, body, text: '' }
  return state.current
}

function handleChunk(payload) {
  const text = textOf(payload)
  if (!text) return
  const stick = isNearBottom()
  const turn = ensureAssistantBubble()
  turn.text += text
  turn.body.textContent = turn.text
  turn.node.classList.add('is-streaming')
  if (stick) el.messages.scrollTop = el.messages.scrollHeight
}

function handleAssistant(payload) {
  const text = textOf(payload)
  const stick = isNearBottom()
  const turn = ensureAssistantBubble()
  const finalText = text || turn.text || '（空回复）'
  turn.text = finalText
  turn.body.textContent = finalText
  turn.node.classList.remove('is-streaming')
  state.current = null
  if (stick) el.messages.scrollTop = el.messages.scrollHeight
}

function appendNotice(message) {
  const stick = isNearBottom()
  hideEmpty()
  const note = document.createElement('p')
  note.className = 'notice'
  note.setAttribute('role', 'alert')
  note.textContent = message
  el.messages.append(note)
  if (stick) stickToBottom(true)
}

// ── 发送 ─────────────────────────────────────

function updateSendButton() {
  if (!state.token) {
    el.send.disabled = true
    el.send.textContent = '发送'
    return
  }
  if (state.sending) {
    el.send.disabled = true
    el.send.textContent = '发送中…'
    return
  }
  if (Date.now() < state.retryAt) {
    el.send.disabled = true
    el.send.textContent = '稍候…'
    return
  }
  el.send.disabled = false
  el.send.textContent = state.failed ? '重试' : '发送'
}

async function describeFailure(res) {
  if (res.status === 401 || res.status === 403) {
    return '令牌无效或已过期，请用带 ?token= 的新链接打开'
  }
  let detail = ''
  try {
    const body = await res.json()
    if (body && typeof body === 'object') {
      detail = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : ''
    }
  } catch {
    // 非 JSON 响应，交给状态码兜底
  }
  return detail ? `发送失败（HTTP ${res.status}）：${detail}` : `发送失败（HTTP ${res.status}）`
}

async function sendMessage(text) {
  if (!state.token) {
    appendNotice('缺少访问令牌，无法发送')
    return
  }
  if (state.sending || Date.now() < state.retryAt) return

  state.sending = true
  el.input.value = ''
  resizeInput()
  appendBubble('user').body.textContent = text
  if (state.current) state.current.node.classList.remove('is-streaming')
  state.current = null // 新一轮回复写入新气泡
  updateSendButton()

  try {
    const res = await fetch(ENDPOINTS.messages, {
      method: 'POST',
      headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ text }),
    })
    if (!res.ok) throw new Error(await describeFailure(res))
    state.sending = false
    state.failed = false
    updateSendButton()
    el.input.focus()
  } catch (error) {
    state.sending = false
    state.failed = true
    const detail = error instanceof TypeError ? '网络错误，消息没有送达' : error.message || '发送失败'
    appendNotice(detail)
    if (!el.input.value.trim()) {
      el.input.value = text
      resizeInput()
    }
    state.retryAt = Date.now() + SEND_RETRY_MS
    updateSendButton()
    clearTimeout(state.retryTimer)
    state.retryTimer = setTimeout(() => {
      state.retryAt = 0
      updateSendButton()
      el.input.focus()
    }, SEND_RETRY_MS)
  }
}

function submit() {
  if (el.send.disabled) return
  const text = el.input.value.trim()
  if (!text) return
  void sendMessage(text)
}

// ── 输入框 ───────────────────────────────────

function resizeInput() {
  el.input.style.height = 'auto'
  el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`
}

function bindEvents() {
  el.form.addEventListener('submit', (event) => {
    event.preventDefault()
    submit()
  })

  el.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    submit()
  })

  el.input.addEventListener('input', resizeInput)

  window.addEventListener('offline', () => {
    closeEvents()
    setStatus('offline', '网络已断开')
  })

  window.addEventListener('online', () => {
    state.reconnectAttempt = 0
    connect()
  })
}

async function start() {
  state.token = readUrlToken() || loadToken()
  bindEvents()
  resizeInput()

  if (!state.token) {
    setStatus('offline', '缺少令牌')
    el.input.disabled = true
    el.input.placeholder = '请用带 ?token= 的链接打开'
    updateSendButton()
    appendNotice('地址里缺少 token，请用网关生成的带 ?token= 的链接重新打开。')
    return
  }

  updateSendButton()
  await probeHealth()
  await loadHistory()
  connect()
}

/**
 * 回放历史：刷新页面后对话仍在。
 * 服务端 GET /api/v1/messages 返回 qm_message 原始行（session_id/role/text/created_at），
 * 这里只取展示需要的 role + text，字段缺失的行直接跳过。
 */
async function loadHistory() {
  const url = new URL(ENDPOINTS.messages, location.href)
  url.searchParams.set('conversationId', 'owner')
  url.searchParams.set('limit', '50')
  let rows
  try {
    const res = await fetch(url, { headers: withAuth({ Accept: 'application/json' }) })
    if (!res.ok) return
    rows = await res.json()
  } catch {
    return // 历史拉不到不影响继续对话
  }
  if (!Array.isArray(rows) || rows.length === 0) return
  hideEmpty()
  for (const row of rows) {
    const role = row?.role === 'user' ? 'user' : 'assistant'
    const text =
      typeof row?.text === 'string' ? row.text : typeof row?.content === 'string' ? row.content : ''
    if (!text) continue
    appendBubble(role).body.textContent = text
  }
  stickToBottom(true)
}

void start()
