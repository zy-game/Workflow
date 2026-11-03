// 青梅 Web 客户端（P1）：原生 ES module，零构建、零框架；M0 起迁移 Vue 3（届时本文件被组件替代）。
'use strict'

const TOKEN_KEY = 'qm.token'
const ENDPOINTS = {
  health: './healthz',
  events: './api/v1/events',
  messages: './api/v1/messages',
  memoryFacts: './api/v1/memory/facts',
  schedules: './api/v1/schedules',
  tasks: './api/v1/tasks',
  approvals: './api/v1/approvals',
  approvalDecide: './api/v1/approvals/decide',
  autonomy: './api/v1/autonomy',
  autonomyTick: './api/v1/autonomy/tick',
  autonomyTrust: './api/v1/autonomy/trust',
  autonomyDigest: './api/v1/autonomy/digest',
  autonomyComplaint: './api/v1/autonomy/complaint',
  autonomyRollback: './api/v1/autonomy/rollback',
  conversations: './api/v1/conversations',
  conversationsConfigure: './api/v1/conversations/configure',
  conversationSuggestions: './api/v1/conversations/suggestions',
  conversationSuggestionAccept: './api/v1/conversations/suggestions/accept',
  conversationSuggestionDismiss: './api/v1/conversations/suggestions/dismiss',
  incidents: './api/v1/incidents',
  incidentDispatch: './api/v1/incidents/dispatch',
  incidentRollback: './api/v1/incidents/rollback',
  incidentResolve: './api/v1/incidents/resolve',
  review: './api/v1/review',
  audit: './api/v1/audit',
  persona: './api/v1/persona',
  personaHistory: './api/v1/persona/history',
  personaApply: './api/v1/persona/apply',
  personaRollback: './api/v1/persona/rollback',
  skillsHistory: './api/v1/skills/history',
  skillsRollback: './api/v1/skills/rollback',
  reviewCards: './api/v1/review/cards',
  reviewCardScore: './api/v1/review/cards/score',
  reviewRun: './api/v1/review/run',
  reviewScore: './api/v1/review/score',
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
  schedulesToggle: document.getElementById('schedules-toggle'),
  schedules: document.getElementById('schedules'),
  schedulesList: document.getElementById('schedules-list'),
  schedulesEmpty: document.getElementById('schedules-empty'),
  schedulesError: document.getElementById('schedules-error'),
  schedulesRefresh: document.getElementById('schedules-refresh'),
  schedulesClose: document.getElementById('schedules-close'),
  memoriesToggle: document.getElementById('memories-toggle'),
  memories: document.getElementById('memories'),
  memoriesList: document.getElementById('memories-list'),
  memoriesEmpty: document.getElementById('memories-empty'),
  memoriesError: document.getElementById('memories-error'),
  memoriesRefresh: document.getElementById('memories-refresh'),
  memoriesClose: document.getElementById('memories-close'),
  tasksToggle: document.getElementById('tasks-toggle'),
  tasks: document.getElementById('tasks'),
  tasksList: document.getElementById('tasks-list'),
  tasksEmpty: document.getElementById('tasks-empty'),
  tasksError: document.getElementById('tasks-error'),
  tasksRefresh: document.getElementById('tasks-refresh'),
  tasksClose: document.getElementById('tasks-close'),
  approvals: document.getElementById('approvals'),
  approvalsList: document.getElementById('approvals-list'),
  autonomyToggle: document.getElementById('autonomy-toggle'),
  autonomy: document.getElementById('autonomy'),
  autonomyList: document.getElementById('autonomy-list'),
  autonomyEmpty: document.getElementById('autonomy-empty'),
  autonomyBudget: document.getElementById('autonomy-budget'),
  autonomyError: document.getElementById('autonomy-error'),
  autonomyRefresh: document.getElementById('autonomy-refresh'),
  autonomyTick: document.getElementById('autonomy-tick'),
  autonomyDigest: document.getElementById('autonomy-digest'),
  autonomyComplain: document.getElementById('autonomy-complain'),
  autonomyRollback: document.getElementById('autonomy-rollback'),
  conversationsToggle: document.getElementById('conversations-toggle'),
  conversations: document.getElementById('conversations'),
  conversationsList: document.getElementById('conversations-list'),
  conversationsSuggestions: document.getElementById('conversations-suggestions'),
  incidentsToggle: document.getElementById('incidents-toggle'),
  incidents: document.getElementById('incidents'),
  incidentsList: document.getElementById('incidents-list'),
  incidentsEmpty: document.getElementById('incidents-empty'),
  incidentsError: document.getElementById('incidents-error'),
  incidentsRefresh: document.getElementById('incidents-refresh'),
  incidentsClose: document.getElementById('incidents-close'),
  reviewToggle: document.getElementById('review-toggle'),
  review: document.getElementById('review'),
  reviewMarkdown: document.getElementById('review-markdown'),
  reviewEmpty: document.getElementById('review-empty'),
  reviewError: document.getElementById('review-error'),
  reviewRun: document.getElementById('review-run'),
  reviewRefresh: document.getElementById('review-refresh'),
  reviewClose: document.getElementById('review-close'),
  reviewScoreInput: document.getElementById('review-score-input'),
  reviewScoreSubmit: document.getElementById('review-score-submit'),
  reviewCards: document.getElementById('review-cards'),
  auditToggle: document.getElementById('audit-toggle'),
  audit: document.getElementById('audit'),
  auditList: document.getElementById('audit-list'),
  auditEmpty: document.getElementById('audit-empty'),
  auditError: document.getElementById('audit-error'),
  auditConversation: document.getElementById('audit-conversation'),
  auditRefresh: document.getElementById('audit-refresh'),
  auditClose: document.getElementById('audit-close'),
  settingsToggle: document.getElementById('settings-toggle'),
  settings: document.getElementById('settings'),
  settingsError: document.getElementById('settings-error'),
  settingsRefresh: document.getElementById('settings-refresh'),
  settingsClose: document.getElementById('settings-close'),
  personaVersion: document.getElementById('persona-version'),
  personaPrompt: document.getElementById('persona-prompt'),
  personaApply: document.getElementById('persona-apply'),
  personaHistory: document.getElementById('persona-history'),
  skillHistoryName: document.getElementById('skill-history-name'),
  skillHistoryLoad: document.getElementById('skill-history-load'),
  skillHistory: document.getElementById('skill-history'),
  conversationsEmpty: document.getElementById('conversations-empty'),
  conversationsError: document.getElementById('conversations-error'),
  conversationsRefresh: document.getElementById('conversations-refresh'),
  conversationsClose: document.getElementById('conversations-close'),
  autonomyClose: document.getElementById('autonomy-close'),
  autonomyLevels: Array.from(document.querySelectorAll('.autonomy-level')),
  autonomyLock: document.getElementById('autonomy-lock'),
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
  schedulesOpen: false,
  schedulesLoading: false,
  memoriesOpen: false,
  memoriesLoading: false,
  tasksOpen: false,
  tasksLoading: false,
  autonomyOpen: false,
  autonomyLoading: false,
  conversationsOpen: false,
  conversationsLoading: false,
  incidentsOpen: false,
  incidentsLoading: false,
  reviewOpen: false,
  reviewLoading: false,
  auditOpen: false,
  auditLoading: false,
  settingsOpen: false,
  settingsLoading: false,
  reviewId: null,
  autonomyMode: 'A1',
  autonomyLocked: false,
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

  // 任务状态变化：面板开着就刷新，别让用户手动点
  for (const type of ['task-started', 'task-progress', 'task-finished']) {
    source.addEventListener(type, () => {
      if (state.tasksOpen) void loadTasks()
    })
  }

  // 新的审批来了：任务面板开着就刷新，否则至少更新标题提示
  for (const type of ['approval-requested', 'approval-decided']) {
    source.addEventListener(type, () => {
      if (state.tasksOpen) void loadApprovals()
    })
  }

  // 自主循环巡完一次：主动面板开着就刷新
  source.addEventListener('autonomy-tick', () => {
    if (state.autonomyOpen) void loadAutonomy()
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
  // 回合结束后刷新日程面板：用户可能刚在对话里加了提醒
  if (state.schedulesOpen) void loadSchedules()
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

// ── 日程 ─────────────────────────────────────

/** 按日程自己的时区显示时间；时区参数不可用时退回本机时区 */
function formatWhen(iso, timezone) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }
  try {
    return new Intl.DateTimeFormat('zh-CN', timezone ? { ...options, timeZone: timezone } : options).format(date)
  } catch {
    return new Intl.DateTimeFormat('zh-CN', options).format(date)
  }
}

function humanGap(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} 小时`
  return `${Math.round(ms / 86_400_000)} 天`
}

function ruleOf(item) {
  if (typeof item?.cron === 'string' && item.cron) {
    return `cron ${item.cron}${item.timezone ? ` · ${item.timezone}` : ''}`
  }
  if (Number.isFinite(item?.everyMs) && item.everyMs > 0) return `每 ${humanGap(item.everyMs)}`
  return '一次性'
}

function renderSchedules(items) {
  const list = el.schedulesList
  list.replaceChildren()

  const ordered = [...items].sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt))
  const active = ordered.filter((item) => !item.firedAt)
  // 已触发的一次性提醒保留最近 5 条，方便确认“提醒过了”
  const done = ordered.filter((item) => item.firedAt).slice(-5)
  el.schedulesEmpty.hidden = ordered.length > 0
  el.schedulesToggle.title = active.length ? `日程（${active.length} 条待触发）` : '日程'

  for (const item of [...active, ...done]) {
    const paused = Boolean(item.pausedAt)
    const row = document.createElement('li')
    row.className = item.firedAt
      ? 'schedule-item is-done'
      : paused
        ? 'schedule-item is-paused'
        : 'schedule-item'

    const main = document.createElement('div')
    main.className = 'schedule-main'

    const text = document.createElement('p')
    text.className = 'schedule-text'
    text.textContent = typeof item.text === 'string' ? item.text : '（无内容）'

    const meta = document.createElement('p')
    meta.className = 'schedule-meta'
    if (item.firedAt) meta.textContent = `已触发 · ${ruleOf(item)}`
    else if (paused) meta.textContent = `已暂停 · ${ruleOf(item)}`
    else meta.textContent = `下次 ${formatWhen(item.nextAt, item.timezone)} · ${ruleOf(item)}`

    main.append(text, meta)
    row.append(main)

    if (!item.firedAt && typeof item.id === 'string' && item.id) {
      const actions = document.createElement('div')
      actions.className = 'schedule-actions'

      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'schedule-action'
      edit.textContent = '编辑'
      edit.addEventListener('click', () => openScheduleEditor(item, row))
      actions.append(edit)

      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'schedule-action'
      toggle.textContent = paused ? '继续' : '暂停'
      toggle.addEventListener('click', () => void setSchedulePaused(item.id, !paused, toggle))
      actions.append(toggle)

      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'schedule-cancel'
      cancel.textContent = '取消'
      cancel.addEventListener('click', () => void cancelSchedule(item.id, cancel))
      actions.append(cancel)

      row.append(actions)
    }
    list.append(row)
  }
}

/** datetime-local 需要本地时区的 YYYY-MM-DDTHH:mm（不带秒） */
function localDateTimeValue(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function labelledField(label, input) {
  const wrap = document.createElement('label')
  wrap.className = 'schedule-field'
  const caption = document.createElement('span')
  caption.className = 'schedule-field-label'
  caption.textContent = label
  wrap.append(caption, input)
  return wrap
}

function editorInput(type, value) {
  const input = document.createElement('input')
  input.type = type
  input.className = 'schedule-input'
  input.value = value
  return input
}

/**
 * 行内编辑：内容 + 规则。
 *
 * 规则字段随日程类型变：cron 行编辑表达式与时区，固定间隔行编辑秒数，
 * 一次性行编辑本地时间（datetime-local 按浏览器时区解释）。
 */
function openScheduleEditor(item, row) {
  const form = document.createElement('form')
  form.className = 'schedule-edit'
  form.autocomplete = 'off'

  const textInput = editorInput('text', typeof item.text === 'string' ? item.text : '')
  form.append(labelledField('内容', textInput))

  let buildRule = () => ({})
  if (typeof item.cron === 'string' && item.cron) {
    const cronInput = editorInput('text', item.cron)
    const tzInput = editorInput('text', item.timezone ?? '')
    const pair = document.createElement('div')
    pair.className = 'schedule-field-pair'
    pair.append(cronInput, tzInput)
    form.append(labelledField('规则（cron）与时区', pair))
    buildRule = () => ({ cron: cronInput.value.trim(), timezone: tzInput.value.trim() })
  } else if (Number.isFinite(item.everyMs) && item.everyMs > 0) {
    const secondsInput = editorInput('number', String(Math.round(item.everyMs / 1000)))
    form.append(labelledField('间隔（秒）', secondsInput))
    buildRule = () => ({ everyMs: Number(secondsInput.value) * 1000 })
  } else {
    const whenInput = editorInput('datetime-local', localDateTimeValue(item.nextAt))
    form.append(labelledField('时间（本地）', whenInput))
    buildRule = () => ({ at: new Date(whenInput.value).toISOString() })
  }

  const actions = document.createElement('div')
  actions.className = 'schedule-actions'

  const save = document.createElement('button')
  save.type = 'submit'
  save.className = 'schedule-action is-primary'
  save.textContent = '保存'

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'schedule-cancel'
  cancel.textContent = '取消'
  cancel.addEventListener('click', () => void loadSchedules())

  actions.append(save, cancel)
  form.append(actions)

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void saveScheduleEdit(item.id, textInput.value, buildRule(), save)
  })

  row.replaceChildren(form)
  textInput.focus()
}

async function saveScheduleEdit(id, text, rulePatch, button) {
  const body = { text: String(text ?? '').trim(), ...rulePatch }
  if (!body.text) {
    showSchedulesError('提醒内容不能为空')
    return
  }
  if (body.cron !== undefined && !body.cron) {
    showSchedulesError('cron 不能为空')
    return
  }
  if (body.everyMs !== undefined && !(body.everyMs > 0)) {
    showSchedulesError('间隔必须是正数')
    return
  }
  if (body.at !== undefined && Number.isNaN(Date.parse(body.at))) {
    showSchedulesError('时间格式不对')
    return
  }

  button.disabled = true
  button.textContent = '保存中…'
  try {
    const res = await fetch(`${ENDPOINTS.schedules}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify(body),
    })
    if (res.status === 404) {
      showSchedulesError('这条提醒已经结束，改不了了')
    } else if (!res.ok) {
      const detail = await res.json().catch(() => null)
      throw new Error(detail?.error || `保存失败（HTTP ${res.status}）`)
    } else {
      showSchedulesError('')
    }
    void loadSchedules()
  } catch (error) {
    showSchedulesError(error instanceof TypeError ? '无法连接服务' : error.message || '保存失败')
    button.disabled = false
    button.textContent = '保存'
  }
}

function showSchedulesError(message) {
  el.schedulesError.textContent = message || ''
  el.schedulesError.hidden = !message
}

async function loadSchedules() {
  if (!state.token || state.schedulesLoading) return
  state.schedulesLoading = true
  showSchedulesError('')
  try {
    const res = await fetch(ENDPOINTS.schedules, {
      headers: withAuth({ Accept: 'application/json' }),
      cache: 'no-store',
    })
    if (res.status === 401 || res.status === 403) throw new Error('令牌无效或已过期')
    if (!res.ok) throw new Error(`读取日程失败（HTTP ${res.status}）`)
    const body = await res.json()
    renderSchedules(Array.isArray(body?.items) ? body.items : [])
  } catch (error) {
    showSchedulesError(error instanceof TypeError ? '无法连接服务' : error.message || '读取日程失败')
  } finally {
    state.schedulesLoading = false
  }
}

async function setSchedulePaused(id, paused, button) {
  const label = button.textContent
  button.disabled = true
  button.textContent = paused ? '暂停中…' : '继续中…'
  try {
    const res = await fetch(`${ENDPOINTS.schedules}/${encodeURIComponent(id)}/${paused ? 'pause' : 'resume'}`, {
      method: 'POST',
      headers: withAuth({ Accept: 'application/json' }),
    })
    if (res.status === 404) {
      showSchedulesError(paused ? '这条提醒已经不在了' : '这条提醒不存在或已经结束')
    } else if (!res.ok) {
      throw new Error(res.status === 401 ? '令牌无效或已过期' : `操作失败（HTTP ${res.status}）`)
    } else {
      showSchedulesError('')
    }
    void loadSchedules()
  } catch (error) {
    showSchedulesError(error instanceof TypeError ? '无法连接服务' : error.message || '操作失败')
    button.disabled = false
    button.textContent = label
  }
}

async function cancelSchedule(id, button) {  button.disabled = true
  button.textContent = '取消中…'
  try {
    const res = await fetch(`${ENDPOINTS.schedules}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: withAuth({ Accept: 'application/json' }),
    })
    if (res.status === 404) {
      showSchedulesError('这条提醒已经不在了')
    } else if (!res.ok) {
      throw new Error(res.status === 401 ? '令牌无效或已过期' : `取消失败（HTTP ${res.status}）`)
    } else {
      showSchedulesError('')
      button.closest('.schedule-item')?.remove()
    }
    void loadSchedules()
  } catch (error) {
    showSchedulesError(error instanceof TypeError ? '无法连接服务' : error.message || '取消失败')
    button.disabled = false
    button.textContent = '取消'
  }
}

function setConversationsOpen(open) {
  state.conversationsOpen = open
  if (!el.conversations) return
  el.conversations.hidden = !open
  el.conversationsToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    setTasksOpen(false)
    setSchedulesOpen(false)
    setAutonomyOpen(false)
    setIncidentsOpen(false)
    setReviewOpen(false)
    void loadConversations()
  }
}

const CONVERSATION_STATUS_TEXT = {
  pending: '待配置',
  configured: '已配置',
  muted: '静音',
  blocked: '已拉黑',
}

const CONVERSATION_TAGS = [
  ['work', '工作'],
  ['casual', '吹水'],
  ['family', '家人'],
  ['client', '客户'],
  ['temp', '临时'],
]

async function loadConversations() {
  if (!state.token || state.conversationsLoading) return
  state.conversationsLoading = true
  try {
    const [res, suggestions] = await Promise.all([
      fetch(ENDPOINTS.conversations, { headers: withAuth({ Accept: 'application/json' }) }),
      fetch(ENDPOINTS.conversationSuggestions, { headers: withAuth({ Accept: 'application/json' }) }),
    ])
    if (!res.ok) throw new Error(`加载群组失败（HTTP ${res.status}）`)
    renderConversations(await res.json())
    renderConversationSuggestions(suggestions.ok ? await suggestions.json() : { items: [] })
    showConversationsError('')
  } catch (error) {
    showConversationsError(error instanceof TypeError ? '无法连接服务' : error.message || '加载群组失败')
  } finally {
    state.conversationsLoading = false
  }
}

function renderConversationSuggestions(body) {
  const items = Array.isArray(body?.items) ? body.items : []
  if (!el.conversationsSuggestions) return
  el.conversationsSuggestions.replaceChildren()
  for (const item of items) {
    const row = document.createElement('li')
    row.className = 'autonomy-item'
    const text = document.createElement('p')
    text.className = 'autonomy-budget'
    text.textContent = `💡 ${item.conversationId} 可能是 ${item.tag}（${item.evidence}）`
    const accept = document.createElement('button')
    accept.className = 'ghost'
    accept.type = 'button'
    accept.textContent = '采纳'
    accept.addEventListener('click', () => void decideSuggestion(item.id, true))
    const dismiss = document.createElement('button')
    dismiss.className = 'ghost'
    dismiss.type = 'button'
    dismiss.textContent = '忽略'
    dismiss.addEventListener('click', () => void decideSuggestion(item.id, false))
    row.append(text, accept, dismiss)
    el.conversationsSuggestions.append(row)
  }
}

async function decideSuggestion(id, accept) {
  if (!state.token) return
  try {
    const res = await fetch(
      accept ? ENDPOINTS.conversationSuggestionAccept : ENDPOINTS.conversationSuggestionDismiss,
      {
        method: 'POST',
        headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        body: JSON.stringify({ id }),
      },
    )
    const detail = await res.json().catch(() => null)
    if (!res.ok) throw new Error(detail?.error || `操作失败（HTTP ${res.status}）`)
    showConversationsError('')
    await loadConversations()
    setStatus('online', accept ? '已采纳标签建议' : '已忽略标签建议')
  } catch (error) {
    showConversationsError(error instanceof TypeError ? '无法连接服务' : error.message || '操作失败')
  }
}

function renderConversations(body) {
  const items = Array.isArray(body?.items) ? body.items : []
  if (!el.conversationsList) return
  el.conversationsList.replaceChildren()
  if (el.conversationsEmpty) el.conversationsEmpty.hidden = items.length > 0
  for (const item of items) {
    const row = document.createElement('li')
    row.className = 'autonomy-item'

    const title = document.createElement('p')
    title.className = 'autonomy-title'
    title.textContent = item.title || item.platformConversationId
    const meta = document.createElement('p')
    meta.className = 'autonomy-budget'
    meta.textContent = `${item.channel} · ${CONVERSATION_STATUS_TEXT[item.status] ?? item.status} · ${item.platformConversationId}`
    const tags = document.createElement('div')
    tags.className = 'conversation-tags'
    for (const [value, label] of CONVERSATION_TAGS) {
      const wrapper = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.value = value
      input.checked = Array.isArray(item.tags) && item.tags.includes(value)
      wrapper.append(input, document.createTextNode(label))
      tags.append(wrapper)
    }
    const save = document.createElement('button')
    save.className = 'ghost'
    save.type = 'button'
    save.textContent = '保存标签'
    save.addEventListener('click', () => {
      const selected = Array.from(tags.querySelectorAll('input:checked')).map((input) => input.value)
      void saveConversationTags(item, selected)
    })
    row.append(title, meta, tags, save)
    el.conversationsList.append(row)
  }
}

async function saveConversationTags(item, tags) {
  if (!state.token) return
  if (tags.length === 0) {
    showConversationsError('至少选一个标签')
    return
  }
  try {
    const res = await fetch(ENDPOINTS.conversationsConfigure, {
      method: 'POST',
      headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ channel: item.channel, conversationId: item.platformConversationId, tags, title: item.title }),
    })
    const detail = await res.json().catch(() => null)
    if (!res.ok) throw new Error(detail?.error || `保存失败（HTTP ${res.status}）`)
    showConversationsError('')
    await loadConversations()
    setStatus('online', `已保存群标签：${tags.join('/')}`)
  } catch (error) {
    showConversationsError(error instanceof TypeError ? '无法连接服务' : error.message || '保存失败')
  }
}

function showConversationsError(message) {
  if (!el.conversationsError) return
  el.conversationsError.textContent = message
  el.conversationsError.hidden = !message
}

function setIncidentsOpen(open) {
  state.incidentsOpen = open
  if (!el.incidents) return
  el.incidents.hidden = !open
  el.incidentsToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    setTasksOpen(false)
    setSchedulesOpen(false)
    setAutonomyOpen(false)
    setConversationsOpen(false)
    void loadIncidents()
  }
}

const INCIDENT_STATUS_TEXT = {
  open: '待处理',
  proposed: '待处理',
  acknowledged: '已派诊断',
  fused: '已熔断',
  resolved: '已解决',
}

async function loadIncidents() {
  if (!state.token || state.incidentsLoading) return
  state.incidentsLoading = true
  try {
    const res = await fetch(ENDPOINTS.incidents, { headers: withAuth({ Accept: 'application/json' }) })
    if (!res.ok) throw new Error(`加载故障失败（HTTP ${res.status}）`)
    renderIncidents(await res.json())
    showIncidentsError('')
  } catch (error) {
    showIncidentsError(error instanceof TypeError ? '无法连接服务' : error.message || '加载故障失败')
  } finally {
    state.incidentsLoading = false
  }
}

function renderIncidents(body) {
  const items = Array.isArray(body?.items) ? body.items : []
  if (!el.incidentsList) return
  el.incidentsList.replaceChildren()
  if (el.incidentsEmpty) el.incidentsEmpty.hidden = items.length > 0
  for (const item of items) {
    const row = document.createElement('li')
    row.className = 'autonomy-item'
    const title = document.createElement('p')
    title.className = 'autonomy-title'
    title.textContent = `${INCIDENT_STATUS_TEXT[item.status] ?? item.status} · ${item.fingerprint}`
    const meta = document.createElement('p')
    meta.className = 'autonomy-budget'
    meta.textContent = `${String(item.message).slice(0, 120)} · 出现 ${item.count} 次 · ${formatWhen(item.lastAt, null)}`
    row.append(title, meta)

    const tools = document.createElement('div')
    tools.className = 'autonomy-tools'
    if (item.status === 'proposed' || item.status === 'open' || item.status === 'fused') {
      const dispatch = document.createElement('button')
      dispatch.className = 'ghost'
      dispatch.type = 'button'
      dispatch.textContent = '派诊断'
      dispatch.addEventListener('click', () => void incidentAction(ENDPOINTS.incidentDispatch, item.id, '已派诊断'))
      tools.append(dispatch)
    }
    if (item.runId) {
      const rollback = document.createElement('button')
      rollback.className = 'ghost'
      rollback.type = 'button'
      rollback.textContent = '回滚任务'
      rollback.addEventListener('click', () => void incidentAction(ENDPOINTS.incidentRollback, item.id, '已回滚'))
      tools.append(rollback)
    }
    if (item.status !== 'resolved') {
      const resolve = document.createElement('button')
      resolve.className = 'ghost'
      resolve.type = 'button'
      resolve.textContent = '解决'
      resolve.addEventListener('click', () => void incidentAction(ENDPOINTS.incidentResolve, item.id, '已解决'))
      tools.append(resolve)
    }
    row.append(tools)
    el.incidentsList.append(row)
  }
}

async function incidentAction(endpoint, id, okText) {
  if (!state.token) return
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ id }),
    })
    const detail = await res.json().catch(() => null)
    if (!res.ok) throw new Error(detail?.error || `操作失败（HTTP ${res.status}）`)
    showIncidentsError('')
    await loadIncidents()
    setStatus('online', okText)
  } catch (error) {
    showIncidentsError(error instanceof TypeError ? '无法连接服务' : error.message || '操作失败')
  }
}

function showIncidentsError(message) {
  if (!el.incidentsError) return
  el.incidentsError.textContent = message
  el.incidentsError.hidden = !message
}

function setReviewOpen(open) {
  state.reviewOpen = open
  if (!el.review) return
  el.review.hidden = !open
  el.reviewToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    setTasksOpen(false)
    setSchedulesOpen(false)
    setAutonomyOpen(false)
    setConversationsOpen(false)
    setIncidentsOpen(false)
    void loadReview()
  }
}

async function loadReviewCards() {
  if (!el.reviewCards) return
  el.reviewCards.replaceChildren()
  try {
    const res = await fetch(ENDPOINTS.reviewCards, { headers: withAuth({ Accept: 'application/json' }) })
    if (!res.ok) return
    const body = await res.json()
    const cards = Array.isArray(body.items) ? body.items.slice(0, 20) : []
    for (const card of cards) {
      const node = document.createElement('div')
      node.className = 'review-card'
      const text = document.createElement('p')
      text.textContent = `${card.role === 'user' ? '你' : '青梅'}：${card.text}`
      const actions = document.createElement('div')
      actions.className = 'review-card-actions'
      for (const [score, label] of [[8, '👍 好'], [3, '👎 差']]) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'ghost'
        button.textContent = card.score === null ? label : `${label}（已评 ${card.score}）`
        button.disabled = card.score !== null
        button.addEventListener('click', () => void scoreReviewCard(card.id, score, button))
        actions.append(button)
      }
      node.append(text, actions)
      el.reviewCards.append(node)
    }
  } catch {
    // 评分卡是可选增强，失败不挡复盘正文
  }
}

async function scoreReviewCard(id, score, button) {
  button.disabled = true
  const res = await fetch(ENDPOINTS.reviewCardScore, {
    method: 'POST',
    headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ id, score }),
  })
  if (!res.ok) {
    button.disabled = false
    showReviewError(`评分失败（HTTP ${res.status}）`)
    return
  }
  button.textContent = `${score >= 6 ? '👍 好' : '👎 差'}（已评 ${score}）`
}
async function loadReview() {
  if (!state.token || state.reviewLoading) return
  state.reviewLoading = true
  try {
    const res = await fetch(ENDPOINTS.review, { headers: withAuth({ Accept: 'application/json' }) })
    if (!res.ok) throw new Error(`加载复盘失败（HTTP ${res.status}）`)
    const body = await res.json()
    renderReview(Array.isArray(body.items) ? body.items[0] : null)
    await loadReviewCards()
    showReviewError('')
  } catch (error) {
    showReviewError(error instanceof TypeError ? '无法连接服务' : error.message || '加载复盘失败')
  } finally {
    state.reviewLoading = false
  }
}

function renderReview(item) {
  if (!el.reviewMarkdown) return
  state.reviewId = item?.id ?? null
  el.reviewMarkdown.textContent = item?.markdown ?? ''
  if (el.reviewEmpty) el.reviewEmpty.hidden = Boolean(item)
  if (el.reviewScoreInput) el.reviewScoreInput.value = item?.score ?? ''
}

async function runReview() {
  if (!state.token) return
  try {
    const res = await fetch(ENDPOINTS.reviewRun, {
      method: 'POST',
      headers: withAuth({ Accept: 'application/json' }),
    })
    const detail = await res.json().catch(() => null)
    if (!res.ok) throw new Error(detail?.error || `生成失败（HTTP ${res.status}）`)
    renderReview(detail?.review ?? null)
    showReviewError('')
    setStatus('online', '已生成月度复盘')
  } catch (error) {
    showReviewError(error instanceof TypeError ? '无法连接服务' : error.message || '生成失败')
  }
}

async function submitReviewScore() {
  if (!state.token || !state.reviewId) return
  const score = Number(el.reviewScoreInput?.value)
  if (!Number.isFinite(score) || score < 1 || score > 10) {
    showReviewError('评分需在 1..10')
    return
  }
  try {
    const res = await fetch(ENDPOINTS.reviewScore, {
      method: 'POST',
      headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ id: state.reviewId, score }),
    })
    const detail = await res.json().catch(() => null)
    if (!res.ok) throw new Error(detail?.error || `提交失败（HTTP ${res.status}）`)
    showReviewError('')
    await loadReview()
    setStatus('online', `已记录评分 ${score}/10`)
  } catch (error) {
    showReviewError(error instanceof TypeError ? '无法连接服务' : error.message || '提交失败')
  }
}

function showReviewError(message) {
  if (!el.reviewError) return
  el.reviewError.textContent = message
  el.reviewError.hidden = !message
}

function setSchedulesOpen(open) {
  state.schedulesOpen = open
  el.schedules.hidden = !open
  el.schedulesToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    setTasksOpen(false)
    setAutonomyOpen(false)
    setIncidentsOpen(false)
    setReviewOpen(false)
    void loadSchedules()
  }
}

// ── 任务 ─────────────────────────────────────

const TASK_STATUS_TEXT = {
  queued: '排队中',
  running: '执行中',
  needs_approval: '等确认',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

function showTasksError(message) {
  el.tasksError.textContent = message || ''
  el.tasksError.hidden = !message
}

function renderTasks(items) {
  const list = el.tasksList
  list.replaceChildren()
  el.tasksEmpty.hidden = items.length > 0
  const running = items.filter((run) => run.status === 'running' || run.status === 'queued').length
  el.tasksToggle.title = running ? `任务（${running} 个在跑）` : '任务'

  for (const run of items) {
    const row = document.createElement('li')
    row.className = `task-item is-${run.status}`

    const title = document.createElement('p')
    title.className = 'task-title'
    title.textContent = typeof run.title === 'string' && run.title ? run.title : '（未命名任务）'

    const meta = document.createElement('p')
    meta.className = 'task-meta'
    const status = TASK_STATUS_TEXT[run.status] ?? run.status
    const tokens = run.usage && Number.isFinite(run.usage.totalTokens) ? ` · ${run.usage.totalTokens} tokens` : ''
    const project = typeof run.project === 'string' && run.project ? ` · ${run.project}` : ''
    const priority = Number.isFinite(run.priority) && run.priority !== 5 ? ` · P${run.priority}` : ''
    const depends = Array.isArray(run.dependsOn) && run.dependsOn.length > 0 ? ` · 等 ${run.dependsOn.length} 个前置` : ''
    meta.textContent = `${status} · ${formatWhen(run.createdAt, null)}${project}${priority}${depends}${tokens}`
    row.append(title, meta)

    if (run.progress && typeof run.progress.phase === 'string') {
      const progress = document.createElement('p')
      progress.className = 'task-progress'
      const note = run.progress.note ? ` · ${run.progress.note}` : ''
      progress.textContent = `进度：${run.progress.phase}${note}`
      row.append(progress)
    }

    if (Array.isArray(run.artifacts) && run.artifacts.length > 0) {
      const list = document.createElement('ul')
      list.className = 'task-artifacts'
      for (const artifact of run.artifacts) {
        const item = document.createElement('li')
        item.className = 'task-artifact'
        const label = `📎 ${artifact.name}`
        if (typeof artifact.url === 'string' && artifact.url) {
          const link = document.createElement('a')
          link.href = artifact.url
          link.target = '_blank'
          link.rel = 'noopener noreferrer'
          link.textContent = label
          item.append(link)
        } else {
          item.textContent = artifact.path ? `${label} · ${artifact.path}` : label
        }
        list.append(item)
      }
      row.append(list)
    }
    if (run.error) {
      const error = document.createElement('p')
      error.className = 'task-error'
      error.textContent = `错误：${run.error}`
      row.append(error)
    } else if (run.result) {
      const result = document.createElement('p')
      result.className = 'task-result'
      result.textContent = run.result.length > 300 ? `${run.result.slice(0, 300)}…` : run.result
      row.append(result)
    }
    list.append(row)
  }
}

async function loadTasks() {
  if (!state.token || state.tasksLoading) return
  state.tasksLoading = true
  showTasksError('')
  try {
    const res = await fetch(`${ENDPOINTS.tasks}?limit=20`, {
      headers: withAuth({ Accept: 'application/json' }),
      cache: 'no-store',
    })
    if (res.status === 401 || res.status === 403) throw new Error('令牌无效或已过期')
    if (!res.ok) throw new Error(`读取任务失败（HTTP ${res.status}）`)
    const body = await res.json()
    renderTasks(Array.isArray(body?.items) ? body.items : [])
  } catch (error) {
    showTasksError(error instanceof TypeError ? '无法连接服务' : error.message || '读取任务失败')
  } finally {
    state.tasksLoading = false
  }
}

function setTasksOpen(open) {
  state.tasksOpen = open
  if (!el.tasks) return
  el.tasks.hidden = !open
  el.tasksToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    setSchedulesOpen(false)
    setAutonomyOpen(false)
    setIncidentsOpen(false)
    setReviewOpen(false)
    void loadTasks()
    void loadApprovals()
  }
}

// ── 主动（自主循环） ─────────────────────────

function setAutonomyOpen(open) {
  state.autonomyOpen = open
  if (!el.autonomy) return
  el.autonomy.hidden = !open
  el.autonomyToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    setTasksOpen(false)
    setSchedulesOpen(false)
    setIncidentsOpen(false)
    setReviewOpen(false)
    void loadAutonomy()
  }
}

const AUTONOMY_EXEC_TEXT = {
  executed: '已执行',
  suggested: '已发建议',
  skipped: '跳过',
  failed: '失败',
}

function showAutonomyError(message) {
  if (!el.autonomyError) return
  el.autonomyError.textContent = message || ''
  el.autonomyError.hidden = !message
}

function renderAutonomy(body) {
  const items = Array.isArray(body?.items) ? body.items : []
  const budget = body?.budget ?? { used: 0, limit: 0 }
  const trust = body?.trust ?? { accepted: 0, ignored: 0, streak: 0 }
  const digestCount = Number(body?.digest?.count) || 0
  const digestText = digestCount > 0 ? ` · 摘要 ${digestCount} 条` : ''
  const complaintsText = Number(trust.complaints) > 0 ? ` · 投诉 ${trust.complaints}` : ''
  el.autonomyBudget.textContent = `模式 ${body?.mode ?? 'A1'} · 今日建议 ${budget.used}/${budget.limit} · 采纳 ${trust.accepted} · 忽略 ${trust.ignored} · 连续 ${trust.streak}${complaintsText}${digestText}`
  if (el.autonomyDigest) el.autonomyDigest.disabled = digestCount === 0
  state.autonomyMode = body?.mode ?? 'A1'
  state.autonomyLocked = Boolean(body?.locked)
  for (const button of el.autonomyLevels ?? []) {
    button.setAttribute('aria-pressed', button.dataset.level === state.autonomyMode ? 'true' : 'false')
  }
  if (el.autonomyLock) {
    el.autonomyLock.setAttribute('aria-pressed', state.autonomyLocked ? 'true' : 'false')
    el.autonomyLock.textContent = state.autonomyLocked ? '已锁死级别' : '锁死级别'
  }
  el.autonomyEmpty.hidden = items.length > 0
  el.autonomyList.replaceChildren()

  for (const trace of items) {
    const row = document.createElement('li')
    row.className = 'autonomy-item'

    const head = document.createElement('p')
    head.className = 'autonomy-line'
    const when = formatWhen(trace.at, null)
    if (trace.chosen) {
      head.textContent = `${when} · 建议：${trace.chosen.title}`
    } else {
      head.textContent = `${when} · 保持沉默`
    }

    const reason = document.createElement('p')
    reason.className = 'autonomy-reason'
    reason.textContent = trace.reason || ''

    row.append(head, reason)

    const details = []
    if (trace.chosen) details.push(`动作 ${trace.chosen.action}（${trace.chosen.risk} 风险）`)
    if (Array.isArray(trace.candidates) && trace.candidates.length > 0) {
      details.push(`候选 ${trace.candidates.map((item) => item.id).join('、')}`)
    }
    if (Array.isArray(trace.suppressed) && trace.suppressed.length > 0) {
      details.push(`压制 ${trace.suppressed.map((item) => `${item.id}：${item.reason}`).join('；')}`)
    }
    if (trace.execution) {
      const status = AUTONOMY_EXEC_TEXT[trace.execution.status] ?? trace.execution.status
      details.push(`回执 ${status}：${trace.execution.detail}`)
    }
    details.push(`预算 ${trace.budget?.used ?? 0}/${trace.budget?.limit ?? 0}`)
    const meta = document.createElement('p')
    meta.className = 'autonomy-meta'
    meta.textContent = details.join(' · ')
    row.append(meta)

    el.autonomyList.append(row)
  }
}

async function loadAutonomy() {
  if (!state.token || state.autonomyLoading) return
  state.autonomyLoading = true
  showAutonomyError('')
  try {
    const res = await fetch(ENDPOINTS.autonomy, {
      headers: withAuth({ Accept: 'application/json' }),
      cache: 'no-store',
    })
    if (res.status === 401 || res.status === 403) throw new Error('令牌无效或已过期')
    if (!res.ok) throw new Error(`读取主动建议失败（HTTP ${res.status}）`)
    renderAutonomy(await res.json())
  } catch (error) {
    showAutonomyError(error instanceof TypeError ? '无法连接服务' : error.message || '读取主动建议失败')
  } finally {
    state.autonomyLoading = false
  }
}

async function setAutonomyTrust(payload) {
  if (!state.token) return
  try {
    const res = await fetch(ENDPOINTS.autonomyTrust, {
      method: 'POST',
      headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => null)
      throw new Error(detail?.error || `设置失败（HTTP ${res.status}）`)
    }
    showAutonomyError('')
    await loadAutonomy()
  } catch (error) {
    showAutonomyError(error instanceof TypeError ? '无法连接服务' : error.message || '设置失败')
  }
}

async function complainAutonomy() {
  if (!state.token) return
  try {
    const res = await fetch(ENDPOINTS.autonomyComplaint, {
      method: 'POST',
      headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ reason: 'Web 面板投诉最近一条建议' }),
    })
    const detail = await res.json().catch(() => null)
    if (!res.ok) throw new Error(detail?.error || `投诉失败（HTTP ${res.status}）`)
    const before = detail?.before ?? state.autonomyMode
    const after = detail?.after ?? before
    showAutonomyError('')
    await loadAutonomy()
    if (before !== after) setStatus('online', `已投诉：${before} → ${after}`)
    else setStatus('online', `已记录投诉（当前 ${after}${detail?.locked ? '，已锁定' : ''}）`)
  } catch (error) {
    showAutonomyError(error instanceof TypeError ? '无法连接服务' : error.message || '投诉失败')
  }
}

async function rollbackAutonomy() {
  if (!state.token) return
  try {
    const res = await fetch(ENDPOINTS.autonomyRollback, {
      method: 'POST',
      headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ reason: 'Web 面板回滚最近动作' }),
    })
    const detail = await res.json().catch(() => null)
    if (!res.ok) throw new Error(detail?.error || `回滚失败（HTTP ${res.status}）`)
    showAutonomyError('')
    await loadAutonomy()
    const action = detail?.action ? ` ${detail.action}` : ''
    const shift = detail?.before !== detail?.after ? `：${detail.before} → ${detail.after}` : ''
    setStatus('online', `已回滚${action}${shift}`)
  } catch (error) {
    showAutonomyError(error instanceof TypeError ? '无法连接服务' : error.message || '回滚失败')
  }
}

async function flushAutonomyDigest() {
  if (!state.token || el.autonomyDigest?.disabled) return
  try {
    const res = await fetch(ENDPOINTS.autonomyDigest, {
      method: 'POST',
      headers: withAuth({ Accept: 'application/json' }),
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => null)
      throw new Error(detail?.error || `发摘要失败（HTTP ）`)
    }
    showAutonomyError('')
    await loadAutonomy()
  } catch (error) {
    showAutonomyError(error instanceof TypeError ? '无法连接服务' : error.message || '发摘要失败')
  }
}

async function tickAutonomy() {
  if (!state.token) return
  if (el.autonomyTick) {
    el.autonomyTick.disabled = true
    el.autonomyTick.textContent = '巡视中…'
  }
  try {
    const res = await fetch(ENDPOINTS.autonomyTick, {
      method: 'POST',
      headers: withAuth({ Accept: 'application/json' }),
    })
    if (!res.ok) throw new Error(`巡视失败（HTTP ${res.status}）`)
    showAutonomyError('')
    await loadAutonomy()
  } catch (error) {
    showAutonomyError(error instanceof TypeError ? '无法连接服务' : error.message || '巡视失败')
  } finally {
    if (el.autonomyTick) {
      el.autonomyTick.disabled = false
      el.autonomyTick.textContent = '立即巡一次'
    }
  }
}

// ── 待确认（审批） ───────────────────────────

let pendingApprovals = 0

function renderApprovals(items) {
  pendingApprovals = items.length
  el.approvals.hidden = items.length === 0
  el.approvalsList.replaceChildren()
  if (items.length === 0) {
    el.tasksToggle.title = '任务'
    return
  }
  el.tasksToggle.title = `任务（${items.length} 项待确认）`

  for (const request of items) {
    const row = document.createElement('li')
    row.className = 'approval-item'

    const prompt = document.createElement('p')
    prompt.className = 'approval-prompt'
    prompt.textContent = typeof request.prompt === 'string' ? request.prompt : request.action

    const meta = document.createElement('p')
    meta.className = 'approval-meta'
    const channelNames = { feishu: '飞书', qq: 'QQ', web: 'Web' }
    const pushed = Array.isArray(request.notifiedTo) && request.notifiedTo.length > 0
      ? ` · 已推送 ${request.notifiedTo.map((id) => channelNames[id] ?? id).join('/')}`
      : ''
    meta.textContent = `${request.requester ?? ''} · ${formatWhen(request.createdAt, null)}${pushed}`

    const actions = document.createElement('div')
    actions.className = 'approval-actions'
    const allow = document.createElement('button')
    allow.type = 'button'
    allow.className = 'approval-allow'
    allow.textContent = '批准'
    allow.addEventListener('click', () => void decideApproval(request.id, true, allow, deny))
    const deny = document.createElement('button')
    deny.type = 'button'
    deny.className = 'schedule-cancel'
    deny.textContent = '拒绝'
    deny.addEventListener('click', () => void decideApproval(request.id, false, allow, deny))
    actions.append(allow, deny)

    row.append(prompt, meta, actions)
    el.approvalsList.append(row)
  }
}

async function loadApprovals() {
  if (!state.token) return
  try {
    const res = await fetch(`${ENDPOINTS.approvals}?status=pending`, {
      headers: withAuth({ Accept: 'application/json' }),
      cache: 'no-store',
    })
    if (!res.ok) return
    const body = await res.json()
    renderApprovals(Array.isArray(body?.items) ? body.items : [])
  } catch {
    // 审批拉不到不影响任务列表
  }
}

async function decideApproval(id, allow, allowButton, denyButton) {
  for (const button of [allowButton, denyButton]) button.disabled = true
  allowButton.textContent = allow ? '批准中…' : '批准'
  denyButton.textContent = allow ? '拒绝' : '拒绝中…'
  try {
    const res = await fetch(ENDPOINTS.approvalDecide, {
      method: 'POST',
      headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ id, allow }),
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => null)
      throw new Error(detail?.error || `操作失败（HTTP ${res.status}）`)
    }
    showTasksError('')
    void loadApprovals()
    void loadTasks()
  } catch (error) {
    showTasksError(error instanceof TypeError ? '无法连接服务' : error.message || '操作失败')
    for (const button of [allowButton, denyButton]) button.disabled = false
    allowButton.textContent = '批准'
    denyButton.textContent = '拒绝'
  }
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
      body: JSON.stringify({ text, deviceId: 'web' }),
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

async function loadMemories() {
  if (!state.token || state.memoriesLoading) return
  state.memoriesLoading = true
  if (el.memoriesError) {
    el.memoriesError.hidden = true
    el.memoriesError.textContent = ''
  }
  try {
    const res = await fetch(ENDPOINTS.memoryFacts, {
      headers: withAuth({ Accept: 'application/json' }),
      cache: 'no-store',
    })
    if (res.status === 401 || res.status === 403) throw new Error('令牌无效或已过期')
    if (!res.ok) throw new Error(`读取记忆失败（HTTP ${res.status}）`)
    const data = await res.json()
    const facts = Array.isArray(data.facts) ? data.facts : []
    if (el.memoriesEmpty) el.memoriesEmpty.hidden = facts.length > 0
    if (el.memoriesList) {
      el.memoriesList.replaceChildren()
      for (const fact of facts) {
        const row = document.createElement('li')
        row.className = 'memory-item'
        const text = document.createElement('div')
        text.className = 'memory-text'
        text.textContent = `${fact.subject} ${fact.predicate} ${fact.object}`
        const meta = document.createElement('small')
        meta.textContent = `置信 ${Math.round(Number(fact.confidence) * 100)}%`
        const actions = document.createElement('div')
        actions.className = 'memory-actions'
        const edit = document.createElement('button')
        edit.type = 'button'
        edit.className = 'ghost'
        edit.textContent = '修正'
        edit.addEventListener('click', () => void editMemory(fact))
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'ghost'
        remove.textContent = '删除'
        remove.addEventListener('click', () => void deleteMemory(fact))
        actions.append(edit, remove)
        row.append(text, meta, actions)
        el.memoriesList.append(row)
      }
    }
  } catch (error) {
    if (el.memoriesError) {
      el.memoriesError.hidden = false
      el.memoriesError.textContent = error instanceof Error ? error.message : '读取记忆失败'
    }
  } finally {
    state.memoriesLoading = false
  }
}

async function editMemory(fact) {
  const next = window.prompt('修正这条记忆的内容', String(fact.object ?? ''))
  if (next === null) return
  const value = next.trim()
  if (!value) return
  const res = await fetch(`${ENDPOINTS.memoryFacts}/${encodeURIComponent(fact.id)}`, {
    method: 'PATCH',
    headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ object: value }),
  })
  if (!res.ok) {
    if (el.memoriesError) {
      el.memoriesError.hidden = false
      el.memoriesError.textContent = `修正失败（HTTP ${res.status}）`
    }
    return
  }
  await loadMemories()
}

async function deleteMemory(fact) {
  if (!window.confirm(`删除「${fact.object}」？`)) return
  const res = await fetch(`${ENDPOINTS.memoryFacts}/${encodeURIComponent(fact.id)}`, {
    method: 'DELETE',
    headers: withAuth({ Accept: 'application/json' }),
  })
  if (!res.ok) {
    if (el.memoriesError) {
      el.memoriesError.hidden = false
      el.memoriesError.textContent = `删除失败（HTTP ${res.status}）`
    }
    return
  }
  await loadMemories()
}

function setMemoriesOpen(open) {
  state.memoriesOpen = open
  if (el.memories) el.memories.hidden = !open
  el.memoriesToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    setSchedulesOpen(false)
    setTasksOpen(false)
    setAutonomyOpen(false)
    setIncidentsOpen(false)
    setReviewOpen(false)
    void loadMemories()
  }
}
async function loadAudit() {
  if (!state.token || state.auditLoading) return
  state.auditLoading = true
  if (el.auditError) {
    el.auditError.hidden = true
    el.auditError.textContent = ''
  }
  try {
    const conversationId = el.auditConversation?.value.trim() ?? ''
    const url = new URL(ENDPOINTS.audit, location.href)
    url.searchParams.set('limit', '50')
    if (conversationId) url.searchParams.set('conversationId', conversationId)
    const res = await fetch(url, { headers: withAuth({ Accept: 'application/json' }), cache: 'no-store' })
    if (!res.ok) throw new Error(`读取审计失败（HTTP ${res.status}）`)
    const body = await res.json()
    const items = Array.isArray(body.items) ? body.items : []
    if (el.auditEmpty) el.auditEmpty.hidden = items.length > 0
    if (el.auditList) {
      el.auditList.replaceChildren()
      for (const item of items) {
        const row = document.createElement('li')
        row.className = 'schedule-item'
        const main = document.createElement('div')
        main.className = 'schedule-main'
        const title = document.createElement('strong')
        title.textContent = `${item.action} · ${item.decision ?? '记录'}`
        const meta = document.createElement('small')
        const at = item.at ? new Date(item.at).toLocaleString('zh-CN') : ''
        meta.textContent = `${item.actorId ?? ''} ${item.conversationId ? `· ${item.conversationId}` : ''} · ${at}`
        main.append(title, meta)
        row.append(main)
        el.auditList.append(row)
      }
    }
  } catch (error) {
    if (el.auditError) {
      el.auditError.hidden = false
      el.auditError.textContent = error instanceof Error ? error.message : '读取审计失败'
    }
  } finally {
    state.auditLoading = false
  }
}

function setAuditOpen(open) {
  state.auditOpen = open
  if (el.audit) el.audit.hidden = !open
  el.auditToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    setSchedulesOpen(false)
    setTasksOpen(false)
    setAutonomyOpen(false)
    setIncidentsOpen(false)
    setReviewOpen(false)
    void loadAudit()
  }
}
function showSettingsError(message) {
  if (!el.settingsError) return
  el.settingsError.hidden = !message
  el.settingsError.textContent = message
}

function personaHistoryRow(entry, onRollback) {
  const row = document.createElement('li')
  row.className = 'schedule-item'
  const main = document.createElement('div')
  main.className = 'schedule-main'
  const title = document.createElement('strong')
  title.textContent = `${entry.version} · ${entry.kind}`
  const meta = document.createElement('small')
  meta.textContent = `${new Date(entry.createdAt).toLocaleString('zh-CN')} · ${entry.note || entry.hash}`
  main.append(title, meta)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'ghost'
  button.textContent = '回滚'
  button.addEventListener('click', () => void onRollback(entry.id))
  row.append(main, button)
  return row
}

async function loadPersona() {
  const res = await fetch(ENDPOINTS.persona, { headers: withAuth({ Accept: 'application/json' }) })
  if (!res.ok) throw new Error(`读取人格失败（HTTP ${res.status}）`)
  const body = await res.json()
  if (el.personaVersion) el.personaVersion.textContent = `当前 ${body.persona.version} · ${body.persona.hash}`
  if (el.personaPrompt) el.personaPrompt.value = body.persona.prompt
}

async function loadPersonaHistory() {
  if (!el.personaHistory) return
  const res = await fetch(ENDPOINTS.personaHistory, { headers: withAuth({ Accept: 'application/json' }) })
  if (!res.ok) throw new Error(`读取人格历史失败（HTTP ${res.status}）`)
  const body = await res.json()
  el.personaHistory.replaceChildren()
  for (const entry of body.items.slice(0, 12)) {
    el.personaHistory.append(personaHistoryRow(entry, rollbackPersona))
  }
}

async function loadSettings() {
  if (!state.token || state.settingsLoading) return
  state.settingsLoading = true
  showSettingsError('')
  try {
    await Promise.all([loadPersona(), loadPersonaHistory()])
  } catch (error) {
    showSettingsError(error instanceof Error ? error.message : '加载设置失败')
  } finally {
    state.settingsLoading = false
  }
}

async function applyPersona() {
  if (!el.personaPrompt) return
  const prompt = el.personaPrompt.value.trim()
  if (!prompt) {
    showSettingsError('提示词不能为空')
    return
  }
  const res = await fetch(ENDPOINTS.personaApply, {
    method: 'POST',
    headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ prompt, note: 'Web 设置页' }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    showSettingsError(body?.error || `应用失败（HTTP ${res.status}）`)
    return
  }
  showSettingsError('')
  await loadSettings()
}

async function rollbackPersona(id) {
  const res = await fetch(ENDPOINTS.personaRollback, {
    method: 'POST',
    headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ id }),
  })
  if (!res.ok) {
    showSettingsError(`回滚失败（HTTP ${res.status}）`)
    return
  }
  await loadSettings()
}

async function loadSkillHistory() {
  if (!el.skillHistory || !el.skillHistoryName) return
  const name = el.skillHistoryName.value.trim()
  if (!name) {
    showSettingsError('先填技能名')
    return
  }
  const url = new URL(ENDPOINTS.skillsHistory, location.href)
  url.searchParams.set('name', name)
  const res = await fetch(url, { headers: withAuth({ Accept: 'application/json' }) })
  if (!res.ok) {
    showSettingsError(`读取技能历史失败（HTTP ${res.status}）`)
    return
  }
  const body = await res.json()
  el.skillHistory.replaceChildren()
  for (const entry of body.items) {
    const row = document.createElement('li')
    row.className = 'schedule-item'
    const main = document.createElement('div')
    main.className = 'schedule-main'
    const title = document.createElement('strong')
    title.textContent = entry.id
    const meta = document.createElement('small')
    meta.textContent = new Date(entry.at).toLocaleString('zh-CN')
    main.append(title, meta)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ghost'
    button.textContent = '回滚'
    button.addEventListener('click', () => void rollbackSkill(name, entry.id))
    row.append(main, button)
    el.skillHistory.append(row)
  }
}

async function rollbackSkill(name, id) {
  const res = await fetch(ENDPOINTS.skillsRollback, {
    method: 'POST',
    headers: withAuth({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ name, id }),
  })
  if (!res.ok) {
    showSettingsError(`技能回滚失败（HTTP ${res.status}）`)
    return
  }
  await loadSkillHistory()
}

function setSettingsOpen(open) {
  state.settingsOpen = open
  if (el.settings) el.settings.hidden = !open
  el.settingsToggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    setAuditOpen(false)
    setSchedulesOpen(false)
    setTasksOpen(false)
    setAutonomyOpen(false)
    setIncidentsOpen(false)
    setReviewOpen(false)
    void loadSettings()
  }
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

  el.schedulesToggle?.addEventListener('click', () => setSchedulesOpen(!state.schedulesOpen))
  el.schedulesRefresh?.addEventListener('click', () => void loadSchedules())
  el.schedulesClose?.addEventListener('click', () => setSchedulesOpen(false))
  el.memoriesToggle?.addEventListener('click', () => setMemoriesOpen(!state.memoriesOpen))
  el.memoriesRefresh?.addEventListener('click', () => void loadMemories())
  el.memoriesClose?.addEventListener('click', () => setMemoriesOpen(false))
  el.tasksToggle?.addEventListener('click', () => setTasksOpen(!state.tasksOpen))
  el.tasksRefresh?.addEventListener('click', () => void loadTasks())
  el.tasksClose?.addEventListener('click', () => setTasksOpen(false))
  el.autonomyToggle?.addEventListener('click', () => setAutonomyOpen(!state.autonomyOpen))
  el.autonomyRefresh?.addEventListener('click', () => void loadAutonomy())
  el.autonomyTick?.addEventListener('click', () => void tickAutonomy())
  el.autonomyClose?.addEventListener('click', () => setAutonomyOpen(false))
  el.autonomyDigest?.addEventListener('click', () => void flushAutonomyDigest())
  for (const button of el.autonomyLevels ?? []) {
    button.addEventListener('click', () => void setAutonomyTrust({ level: button.dataset.level }))
  }
  el.autonomyLock?.addEventListener('click', () => void setAutonomyTrust({ locked: !state.autonomyLocked }))
  el.autonomyComplain?.addEventListener('click', () => void complainAutonomy())
  el.autonomyRollback?.addEventListener('click', () => void rollbackAutonomy())
  el.conversationsToggle?.addEventListener('click', () => setConversationsOpen(!state.conversationsOpen))
  el.conversationsRefresh?.addEventListener('click', () => void loadConversations())
  el.conversationsClose?.addEventListener('click', () => setConversationsOpen(false))
  el.incidentsToggle?.addEventListener('click', () => setIncidentsOpen(!state.incidentsOpen))
  el.incidentsRefresh?.addEventListener('click', () => void loadIncidents())
  el.incidentsClose?.addEventListener('click', () => setIncidentsOpen(false))
  el.reviewToggle?.addEventListener('click', () => setReviewOpen(!state.reviewOpen))
  el.reviewRun?.addEventListener('click', () => void runReview())
  el.reviewRefresh?.addEventListener('click', () => void loadReview())
  el.reviewClose?.addEventListener('click', () => setReviewOpen(false))
  el.reviewScoreSubmit?.addEventListener('click', () => void submitReviewScore())
  el.auditToggle?.addEventListener('click', () => setAuditOpen(!state.auditOpen))
  el.auditRefresh?.addEventListener('click', () => void loadAudit())
  el.auditClose?.addEventListener('click', () => setAuditOpen(false))
  el.settingsToggle?.addEventListener('click', () => setSettingsOpen(!state.settingsOpen))
  el.settingsRefresh?.addEventListener('click', () => void loadSettings())
  el.settingsClose?.addEventListener('click', () => setSettingsOpen(false))
  el.personaApply?.addEventListener('click', () => void applyPersona())
  el.skillHistoryLoad?.addEventListener('click', () => void loadSkillHistory())
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (state.schedulesOpen) setSchedulesOpen(false)
    if (state.tasksOpen) setTasksOpen(false)
    if (state.autonomyOpen) setAutonomyOpen(false)
    if (state.conversationsOpen) setConversationsOpen(false)
    if (state.incidentsOpen) setIncidentsOpen(false)
    if (state.reviewOpen) setReviewOpen(false)
    if (state.auditOpen) setAuditOpen(false)
    if (state.settingsOpen) setSettingsOpen(false)
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
    if (el.schedulesToggle) el.schedulesToggle.disabled = true
    if (el.tasksToggle) el.tasksToggle.disabled = true
    if (el.autonomyToggle) el.autonomyToggle.disabled = true
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
