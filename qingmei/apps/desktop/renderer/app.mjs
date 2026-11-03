import {
  BubbleQueue,
  bubbleForEvent,
  eventsUrl,
  mapHistory,
  normalizeServerUrl,
} from './core.mjs'

const desktop = window.qmDesktop ?? {
  getSettings: async () => ({ serverUrl: 'http://127.0.0.1:7410', token: '' }),
  saveSettings: async () => ({ ok: true }),
  popupMenu: async () => undefined,
  quit: () => undefined,
  onOpenSettings: () => undefined,
  onReconnect: () => undefined,
  onPetAction: () => undefined,
  setIgnoreMouseEvents: () => undefined,
  moveBy: () => undefined,
  hide: () => undefined,
}

const el = {
  app: document.getElementById('app'),
  bubble: document.getElementById('bubble'),
  bubbleKind: document.getElementById('bubble-kind'),
  bubbleText: document.getElementById('bubble-text'),
  bubbleCount: document.getElementById('bubble-count'),
  bubbleClose: document.getElementById('bubble-close'),
  chat: document.getElementById('chat'),
  chatLog: document.getElementById('chat-log'),
  chatTyping: document.getElementById('chat-typing'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  chatSend: document.getElementById('chat-send'),
  chatButton: document.getElementById('chat-button'),
  hearts: document.getElementById('hearts'),
  pet: document.getElementById('pet'),
  settingsButton: document.getElementById('settings-button'),
  statusDot: document.getElementById('status-dot'),
  hint: document.getElementById('hint'),
  settingsModal: document.getElementById('settings-modal'),
  settingsForm: document.getElementById('settings-form'),
  settingsServer: document.getElementById('settings-server'),
  settingsToken: document.getElementById('settings-token'),
  settingsError: document.getElementById('settings-error'),
  settingsTest: document.getElementById('settings-test'),
  settingsCancel: document.getElementById('settings-cancel'),
}

const settings = { serverUrl: '', token: '' }
const bubbles = new BubbleQueue({ ttlMs: 12_000 })
let source = null
let bubbleTimer = 0
let typingTimer = 0
let stateResetTimer = 0
let sending = false
let historyLoaded = false

const KIND_LABEL = { message: '青梅', approval: '审批', error: '故障', pet: '青梅' }
const PET_LINES = [
  '在呢。',
  '摸摸头～',
  '今天也慢慢来。',
  '我在这儿。',
  '要不要喝口水？',
  '别急，一件一件来。',
  '陪你一会儿。',
  '辛苦啦。',
]

const GIFS = {
  idle: ['./assets/gifs/idle-breath.gif', './assets/gifs/idle-look.gif'],
  sleep: './assets/gifs/sleep.gif',
  think: './assets/gifs/think.gif',
  eat: './assets/gifs/eat-rice.gif',
  drag: './assets/gifs/drag.gif',
  click: [
    './assets/gifs/click-happy.gif',
    './assets/gifs/click-wave.gif',
    './assets/gifs/click-shy.gif',
    './assets/gifs/click-pout.gif',
    './assets/gifs/click-tickle.gif',
  ],
  fun: ['./assets/gifs/fun-mirror.gif', './assets/gifs/fun-whale.gif', './assets/gifs/fun-water.gif'],
}

let idleIndex = 0
let clipTimer = 0

function playGif(src, { duration = 0 } = {}) {
  const img = el.pet
  if (!img) return
  img.src = new URL(src, location.href).href + '#' + Date.now()
  clearTimeout(clipTimer)
  if (duration > 0) {
    clipTimer = window.setTimeout(() => {
      if (!['dragging', 'sleeping', 'thinking'].includes(el.app.dataset.state)) {
        setPetState(isOnline() ? 'idle' : 'offline')
      }
    }, duration)
  }
}

function idleClip() {
  playGif(GIFS.idle[idleIndex++ % GIFS.idle.length])
}

function setPetState(state) {
  const previous = el.app.dataset.state
  el.app.dataset.state = state
  if (state === 'idle' || state === 'offline') {
    if (previous !== 'idle' && previous !== 'offline') idleClip()
    return
  }
  if (state === 'sleeping') {
    playGif(GIFS.sleep)
    return
  }
  if (state === 'thinking') {
    playGif(GIFS.think)
    return
  }
  if (state === 'happy' || state === 'alert') {
    playGif(GIFS.click[Math.floor(Math.random() * GIFS.click.length)], { duration: 2400 })
    return
  }
  if (state === 'dragging') {
    playGif(GIFS.drag)
  }
}

function playFun() {
  if (['dragging', 'sleeping', 'thinking'].includes(el.app.dataset.state)) return
  el.app.dataset.state = 'happy'
  playGif(GIFS.fun[Math.floor(Math.random() * GIFS.fun.length)], { duration: 3200 })
  pushBubble('自己找点乐子～', 'pet')
  if (Math.random() < 0.4) spawnHearts(3)
}
function isOnline() {
  return Boolean(source) && source.readyState === EventSource.OPEN
}

function setOnline(online) {
  el.statusDot.classList.toggle('online', online)
  el.statusDot.classList.toggle('offline', !online)
  el.statusDot.title = online ? '已连接' : '未连接'
  if (!online && !el.chat.hidden) el.chatTyping.hidden = true
}

function showError(message, isOk = false) {
  el.settingsError.textContent = message
  el.settingsError.style.color = isOk ? '#2f8f62' : ''
  el.settingsError.hidden = !message
}

async function init() {
  const saved = await desktop.getSettings()
  settings.serverUrl = saved.serverUrl || 'http://127.0.0.1:7410'
  settings.token = saved.token || ''
  if (!settings.token) {
    openSettings()
  } else {
    connect()
  }
}

function connect() {
  closeSource()
  const url = eventsUrl(settings.serverUrl, settings.token)
  if (!url) {
    setOnline(false)
    openSettings()
    return
  }
  try {
    source = new EventSource(url)
  } catch {
    setOnline(false)
    return
  }
  setOnline(false)
  source.addEventListener('open', () => {
    setOnline(true)
    setPetState('idle')
    void loadHistory()
  })
  source.addEventListener('error', () => {
    setOnline(false)
    if (!['thinking', 'happy', 'alert', 'dragging'].includes(el.app.dataset.state)) setPetState('offline')
  })
  for (const type of ['assistant', 'approval-requested', 'task-finished']) {
    source.addEventListener(type, (event) => {
      const bubble = bubbleForEvent({ event: type, data: event.data })
      if (!bubble) return
      pushBubble(bubble.text, bubble.kind)
      if (type === 'assistant') {
        const parsed = safeParse(event.data)
        const text = parsed?.blocks ? textOfBlocks(parsed.blocks) : ''
        if (text && !el.chat.hidden) appendLine('assistant', text)
        finishThinking()
      }
    })
  }
}

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function closeSource() {
  if (source) {
    source.close()
    source = null
  }
  setOnline(false)
}

function safeParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function pushBubble(text, kind) {
  const item = bubbles.add(text, kind)
  if (!item) return
  if (kind !== 'pet') setPetState(kind === 'error' ? 'alert' : 'happy')
  renderBubble()
}

function renderBubble() {
  const current = bubbles.current()
  if (!current) {
    el.bubble.hidden = true
    clearTimeout(bubbleTimer)
    return
  }
  el.bubble.hidden = false
  el.bubble.dataset.kind = current.kind
  el.bubbleKind.textContent = KIND_LABEL[current.kind] ?? '青梅'
  el.bubbleText.textContent = current.text
  const rest = bubbles.size - 1
  el.bubbleCount.hidden = rest <= 0
  el.bubbleCount.textContent = rest > 0 ? `+${rest}` : ''
  clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => {
    bubbles.dismiss()
    renderBubble()
  }, bubbles.ttlMs)
}

function dismissBubble() {
  bubbles.dismiss()
  renderBubble()
}

function openChat() {
  if (!el.chat.hidden) {
    el.chatInput.focus()
    return
  }
  el.chat.hidden = false
  el.chatInput.focus()
  if (!historyLoaded) void loadHistory()
  scrollChat()
}

function closeChat() {
  el.chat.hidden = true
}

function toggleChat() {
  if (el.chat.hidden) openChat()
  else closeChat()
}

async function loadHistory() {
  if (!settings.token) return
  const base = normalizeServerUrl(settings.serverUrl)
  if (!base) return
  historyLoaded = true
  try {
    const res = await fetch(`${base}/api/v1/messages?conversationId=owner&limit=20`, {
      headers: { Authorization: `Bearer ${settings.token}`, Accept: 'application/json' },
    })
    if (!res.ok) return
    const rows = await res.json()
    const lines = mapHistory(rows)
    if (lines.length === 0) return
    el.chatLog.replaceChildren()
    for (const line of lines) appendLine(line.role, line.text, false)
    scrollChat()
  } catch {
    // 历史加载失败不影响实时消息
  }
}

function appendLine(role, text, scroll = true) {
  const line = document.createElement('div')
  line.className = `chat-line ${role === 'assistant' ? 'assistant' : 'user'}`
  line.textContent = text
  el.chatLog.append(line)
  if (scroll) scrollChat()
}

function scrollChat() {
  el.chatLog.scrollTop = el.chatLog.scrollHeight
}

function startThinking() {
  setPetState('thinking')
  el.chatTyping.hidden = false
  clearTimeout(typingTimer)
  typingTimer = window.setTimeout(() => finishThinking(), 90_000)
}

function finishThinking() {
  clearTimeout(typingTimer)
  el.chatTyping.hidden = true
  setPetState(isOnline() ? 'idle' : 'offline')
}

async function sendMessage(event) {
  event.preventDefault()
  const text = el.chatInput.value.trim()
  if (!text || sending) return
  if (!settings.token) {
    openSettings()
    return
  }
  const base = normalizeServerUrl(settings.serverUrl)
  if (!base) {
    openSettings()
    return
  }
  sending = true
  el.chatSend.disabled = true
  el.chatInput.value = ''
  appendLine('user', text)
  startThinking()
  try {
    const res = await fetch(`${base}/api/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ text, conversationId: 'owner' }),
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => null)
      throw new Error(detail?.error || `发送失败（HTTP ${res.status}）`)
    }
  } catch (error) {
    appendLine('assistant', `⚠️ ${error instanceof Error ? error.message : '发送失败'}`)
    finishThinking()
    setPetState('alert')
  } finally {
    sending = false
    el.chatSend.disabled = false
    el.chatInput.focus()
  }
}

function openSettings() {
  el.settingsServer.value = settings.serverUrl
  el.settingsToken.value = settings.token
  showError('')
  el.settingsModal.hidden = false
  el.settingsServer.focus()
}

function closeSettings() {
  el.settingsModal.hidden = true
}

async function testConnection() {
  const base = normalizeServerUrl(el.settingsServer.value)
  if (!base) {
    showError('服务器地址不合法')
    return
  }
  showError('正在测试…', true)
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) })
    showError(res.ok ? '连接正常' : `服务返回 ${res.status}`, res.ok)
  } catch {
    showError('连不上服务器，检查地址与网络')
  }
}

async function saveSettings(event) {
  event.preventDefault()
  const base = normalizeServerUrl(el.settingsServer.value)
  const token = el.settingsToken.value.trim()
  if (!base) {
    showError('服务器地址必须是 http(s) URL')
    return
  }
  if (!token) {
    showError('令牌不能为空')
    return
  }
  try {
    await desktop.saveSettings({ serverUrl: base, token })
    settings.serverUrl = base
    settings.token = token
    historyLoaded = false
    closeSettings()
    connect()
  } catch (error) {
    showError(error instanceof Error ? error.message : '保存失败')
  }
}

let lastActivity = Date.now()
let clickTimer = 0
let suppressClick = false
let dragState = null

function markActivity() {
  lastActivity = Date.now()
  if (el.app.dataset.state === 'sleeping') setPetState(isOnline() ? 'idle' : 'offline')
}

function spawnHearts(count = 5) {
  for (let index = 0; index < count; index += 1) {
    const heart = document.createElement('span')
    heart.className = 'heart'
    heart.textContent = index % 2 === 0 ? '💚' : '💛'
    heart.style.left = `${42 + Math.random() * 28}%`
    heart.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 70)}px`)
    heart.style.animationDelay = `${index * 70}ms`
    el.hearts.append(heart)
    window.setTimeout(() => heart.remove(), 1400 + index * 70)
  }
}

function interact() {
  markActivity()
  setPetState('happy')
  pushBubble(PET_LINES[Math.floor(Math.random() * PET_LINES.length)], 'pet')
}

function feed() {
  markActivity()
  el.app.dataset.state = 'happy'
  el.app.dataset.state = 'happy'
  playGif(GIFS.eat, { duration: 3200 })
  pushBubble('好吃！谢谢款待～', 'pet')
  spawnHearts(6)
}

function bind() {
  idleClip()
  window.setInterval(() => {
    if ((el.app.dataset.state === 'idle' || el.app.dataset.state === 'offline') && el.chat.hidden && el.settingsModal.hidden) {
      if (Math.random() < 0.35) playFun()
      else idleClip()
    }
  }, 20000)
  desktop.onPetAction((action) => {
    if (action === 'pet') interact()
    else if (action === 'feed') feed()
    else if (action === 'play') playFun()
    else if (action === 'chat') openChat()
    else if (action === 'hide') desktop.hide()
  })
  el.chatButton.addEventListener('click', () => {
    markActivity()
    toggleChat()
  })
  el.pet.addEventListener('click', () => {
    if (suppressClick) return
    clearTimeout(clickTimer)
    clickTimer = window.setTimeout(interact, 220)
  })
  el.pet.addEventListener('dblclick', () => {
    clearTimeout(clickTimer)
    feed()
  })
  el.pet.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    markActivity()
    dragState = { x: event.screenX, y: event.screenY, moved: false }
    try {
      el.pet.setPointerCapture(event.pointerId)
    } catch {
      // 某些输入设备不支持捕获
    }
  })
  el.pet.addEventListener('pointermove', (event) => {
    if (!dragState) return
    const dx = event.screenX - dragState.x
    const dy = event.screenY - dragState.y
    if (Math.abs(dx) + Math.abs(dy) < 3) return
    dragState.moved = true
    dragState.x = event.screenX
    dragState.y = event.screenY
    suppressClick = true
    el.app.dataset.dragging = 'true'
    if (el.app.dataset.state !== 'dragging') setPetState('dragging')
    desktop.moveBy(dx, dy)
    markActivity()
  })
  const endDrag = () => {
    if (!dragState) return
    const moved = dragState.moved
    dragState = null
    delete el.app.dataset.dragging
    if (moved) {
      setPetState(isOnline() ? 'idle' : 'offline')
      window.setTimeout(() => { suppressClick = false }, 250)
    }
  }
  el.pet.addEventListener('pointerup', endDrag)
  el.pet.addEventListener('pointercancel', endDrag)
  el.pet.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      event.preventDefault()
      interact()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      toggleChat()
    }
  })
  el.pet.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    void desktop.popupMenu()
  })
  el.bubbleText.addEventListener('click', openChat)
  el.bubbleClose.addEventListener('click', (event) => {
    event.stopPropagation()
    dismissBubble()
  })
  el.settingsButton.addEventListener('click', openSettings)
  el.chatForm.addEventListener('submit', (event) => void sendMessage(event))
  el.settingsForm.addEventListener('submit', (event) => void saveSettings(event))
  el.settingsTest.addEventListener('click', () => void testConnection())
  el.settingsCancel.addEventListener('click', () => {
    if (!settings.token) {
      showError('先填令牌才能连接')
      return
    }
    closeSettings()
  })
  let ignoringMouse = true
  desktop.setIgnoreMouseEvents(true)
  window.addEventListener('mousemove', (event) => {
    const target = document.elementFromPoint(event.clientX, event.clientY)
    const interactive = Boolean(
      target?.closest('#pet, #bubble, #chat, #drag-handle, #chat-button, #settings-button, #settings-modal'),
    )
    const next = !interactive
    if (next !== ignoringMouse) {
      ignoringMouse = next
      desktop.setIgnoreMouseEvents(next)
    }
  })
  window.setInterval(() => {
    if (
      Date.now() - lastActivity > 90_000 &&
      el.chat.hidden &&
      el.settingsModal.hidden &&
      el.app.dataset.state !== 'thinking'
    ) {
      setPetState('sleeping')
    }
  }, 5000)
  desktop.onOpenSettings(() => openSettings())
  desktop.onReconnect(() => connect())
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!el.settingsModal.hidden) closeSettings()
      else closeChat()
    }
  })
}

bind()
void init()
