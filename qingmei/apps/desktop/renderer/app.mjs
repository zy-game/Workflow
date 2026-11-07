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
  writeWorkerConfig: async () => ({ ok: false, error: '仅桌面端支持' }),
  startWorker: async () => ({ ok: false, error: '仅桌面端支持' }),
  popupMenu: async () => undefined,
  quit: () => undefined,
  onOpenSettings: () => undefined,
  onReconnect: () => undefined,
  onPetAction: () => undefined,
  notify: () => undefined,
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
  hearts: document.getElementById('hearts'),
  pet: document.getElementById('pet'),
  petOrb: document.getElementById('pet-orb'),
  petStage: document.getElementById('pet-stage'),
  statusDot: document.getElementById('status-dot'),
  hint: document.getElementById('hint'),
  onboarding: document.getElementById('onboarding'),
  onboardingStart: document.getElementById('onboarding-start'),
  onboardingSkip: document.getElementById('onboarding-skip'),
  settingsModal: document.getElementById('settings-modal'),
  settingsScale: document.getElementById('settings-scale'),
  settingsFontScale: document.getElementById('settings-font-scale'),
  settingsFontScaleValue: document.getElementById('settings-font-scale-value'),
  settingsScaleValue: document.getElementById('settings-scale-value'),
  settingsSound: document.getElementById('settings-sound'),
  settingsAutostart: document.getElementById('settings-autostart'),
  settingsNotifyHidden: document.getElementById('settings-notify-hidden'),
  settingsHideFullscreen: document.getElementById('settings-hide-fullscreen'),
  settingsCharacter: document.getElementById('settings-character'),
  settingsForm: document.getElementById('settings-form'),
  settingsServer: document.getElementById('settings-server'),
  settingsToken: document.getElementById('settings-token'),

  settingsStartWorker: document.getElementById('settings-start-worker'),
  settingsSetupWorker: document.getElementById('settings-setup-worker'),
  settingsAgentStatus: document.getElementById('settings-agent-status'),
  settingsError: document.getElementById('settings-error'),
  settingsTest: document.getElementById('settings-test'),
  settingsCancel: document.getElementById('settings-cancel'),
}

const settings = {
  serverUrl: '',
  token: '',
  scale: 1,
  sound: true,
  autoStart: false,
  notifyHidden: true,
  hideOnFullscreen: false,
  fontScale: 1,
  character: 'qingmei',
}
const bubbles = new BubbleQueue({ ttlMs: 12_000 })
let source = null
let bubbleTimer = 0
let typingTimer = 0
let stateResetTimer = 0
let sending = false
let historyLoaded = false
let workerSessionId = null

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

const VIDEOS = {
  idle: ['./assets/webm/idle-breath.webm'],
  sleep: './assets/webm/sleep.webm',
  think: './assets/webm/think.webm',
  eat: './assets/webm/eat-rice.webm',
  drag: './assets/webm/drag.webm',
  click: [
    './assets/webm/click-happy.webm',
    './assets/webm/click-wave.webm',
    './assets/webm/click-shy.webm',
    './assets/webm/click-pout.webm',
    './assets/webm/click-tickle.webm',
  ],
  fun: ['./assets/webm/fun-mirror.webm', './assets/webm/fun-whale.webm', './assets/webm/fun-water.webm'],
}

function applyFontScale() {
  document.documentElement.style.setProperty('--font-scale', String(settings.fontScale || 1))
}

function applyCharacter() {
  const orb = settings.character === 'orb'
  if (el.petOrb) el.petOrb.hidden = !orb
  if (el.pet) el.pet.hidden = orb
  if (!orb) idleClip()
}

let idleIndex = 0
let clipTimer = 0
let currentClip = ''

function playClip(src, { loop = true, duration = 0 } = {}) {
  const video = el.pet
  if (!video) return
  const absolute = new URL(src, location.href).href
  if (currentClip !== absolute) {
    currentClip = absolute
    video.loop = loop
    video.src = src
    video.load()
  } else {
    video.loop = loop
  }
  void video.play().catch(() => undefined)
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
  playClip(VIDEOS.idle[idleIndex++ % VIDEOS.idle.length])
}

function setPetState(state) {
  const previous = el.app.dataset.state
  if (settings.character === 'orb') {
    el.app.dataset.state = state
    if (state === 'happy' || state === 'alert') {
      clearTimeout(clipTimer)
      clipTimer = window.setTimeout(() => setPetState(isOnline() ? 'idle' : 'offline'), 1600)
    }
    return
  }
  el.app.dataset.state = state
  if (state === 'idle' || state === 'offline') {
    if (previous !== 'idle' && previous !== 'offline') idleClip()
    return
  }
  if (state === 'sleeping') {
    playClip(VIDEOS.sleep)
    return
  }
  if (state === 'thinking') {
    playClip(VIDEOS.think)
    return
  }
  if (state === 'happy' || state === 'alert') {
    playClip(VIDEOS.click[Math.floor(Math.random() * VIDEOS.click.length)], { loop: false, duration: 2400 })
    return
  }
  if (state === 'dragging') {
    playClip(VIDEOS.drag)
  }
}

const ACTION_CLIPS = {
  mirror: './assets/webm/fun-mirror.webm',
  whale: './assets/webm/fun-whale.webm',
  water: './assets/webm/fun-water.webm',
  eat: './assets/webm/eat-rice.webm',
  wave: './assets/webm/click-wave.webm',
}

function playAction(kind) {
  markActivity()
  if (kind === 'sleep') {
    setPetState('sleeping')
    return
  }
  if (settings.character === 'orb') {
    el.app.dataset.state = 'happy'
    return
  }
  const src = ACTION_CLIPS[kind]
  if (!src) return
  el.app.dataset.state = 'happy'
  playClip(src, { loop: false, duration: 3200 })
}

function playFun() {
  if (['dragging', 'sleeping', 'thinking'].includes(el.app.dataset.state)) return
  el.app.dataset.state = 'happy'
  if (settings.character === 'orb') {
    clearTimeout(clipTimer)
    clipTimer = window.setTimeout(() => setPetState(isOnline() ? 'idle' : 'offline'), 2600)
  } else {
    playClip(VIDEOS.fun[Math.floor(Math.random() * VIDEOS.fun.length)], { loop: false, duration: 3200 })
  }
  pushBubble('自己找点乐子～', 'pet')
  if (Math.random() < 0.4) spawnHearts(3)
}
let audioContext = null

function beep(frequency = 660, duration = 0.09, type = 'sine') {
  if (!settings.sound) return
  try {
    audioContext ??= new AudioContext()
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = type
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.06, audioContext.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration)
    oscillator.connect(gain).connect(audioContext.destination)
    oscillator.start()
    oscillator.stop(audioContext.currentTime + duration + 0.02)
  } catch {
    // 音频不可用不影响互动
  }
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
  settings.scale = Number(saved.scale) || 1
  settings.fontScale = Number(saved.fontScale) || 1
  settings.sound = saved.sound !== false
  settings.autoStart = saved.autoStart === true
  settings.notifyHidden = saved.notifyHidden !== false
  settings.hideOnFullscreen = saved.hideOnFullscreen === true
  settings.character = saved.character === 'orb' ? 'orb' : 'qingmei'
  applyCharacter()
  applyFontScale()
  if (!settings.token) {
    if (localStorage.getItem('qm.onboarded') === '1') openSettings()
    else el.onboarding.hidden = false
  } else {
    connect()
    void registerDevice()
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
    void flushOutbox()
  })
  source.addEventListener('chunk', (event) => {
    if (!el.chat.hidden) appendChunk(event.data)
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
        if (text) finishAssistant(text)
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
  if (kind !== 'pet') {
    beep(kind === 'error' ? 360 : 880, 0.07)
    if (settings.notifyHidden && document.visibilityState === 'hidden') {
      void desktop.notify({ title: '青梅', body: item.text })
    }
    setPetState(kind === 'error' ? 'alert' : 'happy')
  }
  renderBubble()
}

function renderBubble() {
  const current = bubbles.current()
  if (!current) {
    el.bubble.hidden = true
    clearTimeout(bubbleTimer)
    return
  }
  if (!el.chat.hidden && current.kind === 'message') {
    el.bubble.hidden = true
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
  renderBubble()
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
    for (const line of lines) {
      for (const url of line.images ?? []) appendImage(line.role, url)
      if (line.text && line.text !== '[图片]') appendLine(line.role, line.text, false)
    }
    scrollChat()
  } catch {
    // 历史加载失败不影响实时消息
  }
}

let liveLine = null

function renderInline(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g
  let last = 0
  let match
  while ((match = pattern.exec(text))) {
    if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)))
    const token = match[0]
    if (token.startsWith('**')) {
      const strong = document.createElement('strong')
      strong.textContent = token.slice(2, -2)
      parent.append(strong)
    } else if (token.startsWith('`')) {
      const code = document.createElement('code')
      code.textContent = token.slice(1, -1)
      parent.append(code)
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token)
      const anchor = document.createElement('a')
      anchor.textContent = link?.[1] ?? token
      anchor.href = link?.[2] ?? '#'
      anchor.target = '_blank'
      anchor.rel = 'noreferrer'
      parent.append(anchor)
    }
    last = match.index + token.length
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)))
}

function renderMarkdown(container, text) {
  const lines = String(text ?? '').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const code = []
      index += 1
      while (index < lines.length && !lines[index].startsWith('```')) {
        code.push(lines[index])
        index += 1
      }
      index += 1
      const pre = document.createElement('pre')
      const block = document.createElement('code')
      if (language) block.dataset.language = language
      block.textContent = code.join('\n')
      pre.append(block)
      container.append(pre)
      continue
    }
    if (!line.trim()) {
      index += 1
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const element = document.createElement('h' + heading[1].length)
      renderInline(element, heading[2])
      container.append(element)
      index += 1
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      const list = document.createElement('ul')
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        const item = document.createElement('li')
        renderInline(item, lines[index].replace(/^[-*]\s+/, ''))
        list.append(item)
        index += 1
      }
      container.append(list)
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      const list = document.createElement('ol')
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        const item = document.createElement('li')
        renderInline(item, lines[index].replace(/^\d+\.\s+/, ''))
        list.append(item)
        index += 1
      }
      container.append(list)
      continue
    }
    if (line.startsWith('> ')) {
      const quote = document.createElement('blockquote')
      renderInline(quote, line.slice(2))
      container.append(quote)
      index += 1
      continue
    }
    const paragraph = [line]
    index += 1
    while (index < lines.length && lines[index].trim() && !/^(#{1,3}\s|[-*]\s|\d+\.\s|> |```)/.test(lines[index])) {
      paragraph.push(lines[index])
      index += 1
    }
    const element = document.createElement('p')
    renderInline(element, paragraph.join(' '))
    container.append(element)
  }
}

function appendChunk(raw) {
  const data = safeParse(raw)
  const text = typeof data?.text === 'string' ? data.text : ''
  if (!text) return
  if (!liveLine) {
    liveLine = document.createElement('div')
    liveLine.className = 'chat-line assistant streaming'
    el.chatLog.append(liveLine)
  }
  liveLine.textContent += text
  scrollChat()
}

function finishAssistant(text) {
  if (liveLine) {
    liveLine.classList.remove('streaming')
    liveLine.replaceChildren()
    renderMarkdown(liveLine, text)
    liveLine = null
    scrollChat()
    return
  }
  if (text) appendLine('assistant', text)
}

function appendImage(role, url) {
  const line = document.createElement('div')
  line.className = `chat-line ${role === 'assistant' ? 'assistant' : 'user'}`
  const image = document.createElement('img')
  image.alt = '图片'
  image.src = `${normalizeServerUrl(settings.serverUrl)}${url}?token=${encodeURIComponent(settings.token)}`
  line.append(image)
  el.chatLog.append(line)
  scrollChat()
}

function appendLine(role, text, scroll = true) {
  const line = document.createElement('div')
  line.className = `chat-line ${role === 'assistant' ? 'assistant' : 'user'}`
  if (role === 'assistant') renderMarkdown(line, text)
  else line.textContent = text
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

const OUTBOX_KEY = 'qm.desktop.outbox'

function loadOutbox() {
  try {
    const raw = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((item) => typeof item?.text === 'string') : []
  } catch {
    return []
  }
}

function saveOutbox(items) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-20)))
  } catch {
    // 存储不可用时只能放弃排队
  }
}

function queueOutbox(text) {
  const items = loadOutbox()
  items.push({ text, at: Date.now() })
  saveOutbox(items)
}

async function postText(text, images = []) {
  const base = normalizeServerUrl(settings.serverUrl)
  if (!base) throw new Error('服务器地址不合法')
  const res = await fetch(`${base}/api/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ text, conversationId: 'owner', deviceId: 'desktop', ...(images.length ? { images } : {}) }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.error || `发送失败（HTTP ${res.status}）`)
  }
}

async function flushOutbox() {
  const items = loadOutbox()
  if (items.length === 0) return
  const remaining = []
  for (const item of items) {
    try {
      await postText(item.text)
    } catch {
      remaining.push(item)
      break
    }
  }
  saveOutbox(remaining)
  if (items.length !== remaining.length) {
    appendLine('assistant', `📮 已补发 ${items.length - remaining.length} 条离线消息`)
  }
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

async function sendImage(file) {
  if (!settings.token) {
    openSettings()
    return
  }
  const base = normalizeServerUrl(settings.serverUrl)
  if (!base) {
    openSettings()
    return
  }
  if (!file.type.startsWith('image/')) return
  if (file.size > 4 * 1024 * 1024) {
    appendLine('assistant', '⚠️ 图片超过 4MB，先压一下再发。')
    return
  }
  openChat()
  try {
    const dataUrl = await fileToDataUrl(file)
    const upload = await fetch(`${base}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ mime: file.type, data: dataUrl }),
    })
    const uploaded = await upload.json().catch(() => null)
    if (!upload.ok || typeof uploaded?.url !== 'string') {
      throw new Error(uploaded?.error || `上传失败（HTTP ${upload.status}）`)
    }
    appendImage('user', uploaded.url)
    startThinking()
    await postText('[图片]', [uploaded.url])
    finishThinking()
  } catch (error) {
    appendLine('assistant', `⚠️ ${error instanceof Error ? error.message : '图片发送失败'}`)
    finishThinking()
  }
}
async function sendViaWorker(text) {
  try {
    if (!workerSessionId) {
      const created = await fetch('http://127.0.0.1:7431/session/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harness: 'dsh' }),
        signal: AbortSignal.timeout(1500),
      })
      if (!created.ok) return false
      const detail = await created.json()
      workerSessionId = detail.sessionId
    }
    const res = await fetch('http://127.0.0.1:7431/session/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: workerSessionId, text, stream: true }),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) {
      workerSessionId = null
      return false
    }
    if (!String(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const detail = await res.json()
      finishThinking()
      appendLine('assistant', detail.output || '（本机 ACP 没有返回文本）')
      return true
    }
    const reader = res.body?.getReader()
    if (!reader) return false
    const decoder = new TextDecoder()
    let buffer = ''
    let output = ''
    let closed = false
    finishThinking()
    while (!closed) {
      const read = await reader.read()
      if (read.done) break
      buffer += decoder.decode(read.value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = JSON.parse(line.slice(6))
        if (payload.text) {
          output += payload.text
          appendChunk(JSON.stringify({ text: payload.text }))
        }
        if (payload.output && !payload.text) output = payload.output
        if (payload.stopReason) closed = true
      }
    }
    finishAssistant(output || '（本机 ACP 没有返回文本）')
    return true
  } catch {
    workerSessionId = null
    return false
  }
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
  if (liveLine) {
    liveLine.classList.remove('streaming')
    liveLine = null
  }
  appendLine('user', text)
  startThinking()
  if (await sendViaWorker(text)) {
    sending = false
    el.chatSend.disabled = false
    el.chatInput.focus()
    return
  }
  try {
    const res = await fetch(`${base}/api/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ text, conversationId: 'owner', deviceId: 'desktop', ...(images.length ? { images } : {}) }),
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

async function registerDevice() {
  if (!settings.serverUrl || !settings.token) return
  const deviceId = localStorage.getItem('qm.device') || `desktop-${Math.random().toString(36).slice(2, 10)}`
  localStorage.setItem('qm.device', deviceId)
  try {
    await fetch(`${settings.serverUrl.replace(/\/+$/, '')}/api/v1/devices/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: deviceId,
        name: navigator.userAgent.includes('Windows') ? 'Windows 桌面' : '桌面',
        platform: navigator.userAgent.includes('Windows') ? 'windows' : 'unknown',
        arch: navigator.userAgent.includes('x64') ? 'x64' : '',
        harnesses: [{ kind: 'desktop', acp: false, mcp: false }],
        workerVersion: 'desktop-0.1.0',
      }),
    })
  } catch {
    // 设备上报失败不阻塞聊天
  }
}
function openSettings() {
  el.settingsServer.value = settings.serverUrl
  el.settingsToken.value = settings.token
  el.settingsScale.value = String(settings.scale)
  if (el.settingsFontScale) el.settingsFontScale.value = String(settings.fontScale)
  if (el.settingsFontScaleValue) el.settingsFontScaleValue.textContent = Math.round(settings.fontScale * 100) + '%'
  el.settingsScaleValue.textContent = `${Math.round(settings.scale * 100)}%`
  el.settingsSound.checked = settings.sound
  el.settingsAutostart.checked = settings.autoStart
  el.settingsNotifyHidden.checked = settings.notifyHidden
  el.settingsHideFullscreen.checked = settings.hideOnFullscreen
  el.settingsCharacter.value = settings.character
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

async function writeWorkerConfig() {
  if (!el.settingsAgentStatus) return
  el.settingsAgentStatus.hidden = false
  el.settingsAgentStatus.textContent = '正在写入 Worker 配置…'
  try {
    const result = await desktop.writeWorkerConfig()
    el.settingsAgentStatus.textContent = result?.ok ? result.message : result?.error || '配置失败'
  } catch (error) {
    el.settingsAgentStatus.textContent = error instanceof Error ? error.message : '配置失败'
  }
}

async function startWorker() {
  if (!el.settingsAgentStatus) return
  el.settingsAgentStatus.hidden = false
  el.settingsAgentStatus.textContent = '正在启动 Worker…'
  try {
    const result = await desktop.startWorker()
    el.settingsAgentStatus.textContent = result?.ok ? result.message : result?.error || '启动失败'
  } catch (error) {
    el.settingsAgentStatus.textContent = error instanceof Error ? error.message : '启动失败'
  }
}

async function saveSettings(event) {
  event.preventDefault()
  const base = normalizeServerUrl(el.settingsServer.value)
  const token = el.settingsToken.value.trim()
  const hideOnFullscreen = el.settingsHideFullscreen.checked
  if (!base) {
    showError('服务器地址必须是 http(s) URL')
    return
  }
  if (!token) {
    showError('令牌不能为空')
    return
  }
  try {
    const scale = Number(el.settingsScale.value) || 1
    const fontScale = Number(el.settingsFontScale?.value) || 1
    const sound = el.settingsSound.checked
    const autoStart = el.settingsAutostart.checked
    const notifyHidden = el.settingsNotifyHidden.checked
    const character = el.settingsCharacter.value === 'orb' ? 'orb' : 'qingmei'
    await desktop.saveSettings({ serverUrl: base, token, scale, fontScale, sound, autoStart, notifyHidden, hideOnFullscreen, character })
    settings.serverUrl = base
    settings.token = token
    settings.scale = scale
    settings.fontScale = fontScale
    settings.sound = sound
    settings.autoStart = autoStart
    settings.notifyHidden = notifyHidden
    settings.hideOnFullscreen = hideOnFullscreen
    settings.character = character
    applyCharacter()
    applyFontScale()
    localStorage.setItem('qm.onboarded', '1')
    historyLoaded = false
    void registerDevice()
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
  beep(720, 0.08)
  setPetState('happy')
  pushBubble(PET_LINES[Math.floor(Math.random() * PET_LINES.length)], 'pet')
}

function feed() {
  markActivity()
  beep(520, 0.08)
  window.setTimeout(() => beep(780, 0.1), 90)
  el.app.dataset.state = 'happy'
  if (settings.character === 'orb') {
    clearTimeout(clipTimer)
    clipTimer = window.setTimeout(() => setPetState(isOnline() ? 'idle' : 'offline'), 2600)
  } else {
    playClip(VIDEOS.eat, { loop: false, duration: 3200 })
  }
  pushBubble('好吃！谢谢款待～', 'pet')
  spawnHearts(6)
}

function bind() {
  idleClip()
  window.setInterval(() => {
    if ((el.app.dataset.state === 'idle' || el.app.dataset.state === 'offline') && el.chat.hidden && el.settingsModal.hidden) {
      if (Math.random() < 0.35) playFun()
    }
  }, 20000)
  desktop.onPetAction((action) => {
    if (action === 'pet') interact()
    else if (action === 'feed') feed()
    else if (action === 'play') playFun()
    else if (action.startsWith('play:')) playAction(action.slice(5))
    else if (action === 'chat') openChat()
    else if (action === 'hide') desktop.hide()
  })
  el.petStage.addEventListener('click', () => {
    if (suppressClick) return
    clearTimeout(clickTimer)
    clickTimer = window.setTimeout(interact, 220)
  })
  el.petStage.addEventListener('dblclick', () => {
    clearTimeout(clickTimer)
    feed()
  })
  el.petStage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    markActivity()
    dragState = { x: event.screenX, y: event.screenY, moved: false }
    try {
      el.petStage.setPointerCapture(event.pointerId)
    } catch {
      // 某些输入设备不支持捕获
    }
  })
  el.petStage.addEventListener('pointermove', (event) => {
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
  el.petStage.addEventListener('pointerup', endDrag)
  el.petStage.addEventListener('pointercancel', endDrag)
  el.petStage.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      event.preventDefault()
      interact()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      toggleChat()
    }
  })
  el.petStage.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    void desktop.popupMenu()
  })
  el.bubbleText.addEventListener('click', openChat)
  el.bubbleClose.addEventListener('click', (event) => {
    event.stopPropagation()
    dismissBubble()
  })
  el.chatForm.addEventListener('submit', (event) => void sendMessage(event))
  window.addEventListener('paste', (event) => {
    const item = [...(event.clipboardData?.items ?? [])].find((entry) => entry.type.startsWith('image/'))
    if (!item) return
    event.preventDefault()
    const file = item.getAsFile()
    if (file) void sendImage(file)
  })
  window.addEventListener('dragover', (event) => event.preventDefault())
  window.addEventListener('drop', (event) => {
    const file = [...(event.dataTransfer?.files ?? [])].find((entry) => entry.type.startsWith('image/'))
    if (!file) return
    event.preventDefault()
    void sendImage(file)
  })
  el.settingsForm.addEventListener('submit', (event) => void saveSettings(event))
  el.settingsStartWorker?.addEventListener('click', () => void startWorker())
  el.settingsSetupWorker?.addEventListener('click', () => void writeWorkerConfig())
  el.onboardingStart.addEventListener('click', () => {
    el.onboarding.hidden = true
    localStorage.setItem('qm.onboarded', '1')
    openSettings()
  })
  el.onboardingSkip.addEventListener('click', () => {
    el.onboarding.hidden = true
    localStorage.setItem('qm.onboarded', '1')
  })
  el.settingsTest.addEventListener('click', () => void testConnection())
  el.settingsScale.addEventListener('input', () => {
    el.settingsScaleValue.textContent = `${Math.round(Number(el.settingsScale.value) * 100)}%`
  })
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
      target?.closest('#pet, #bubble, #chat, #drag-handle, #chat-button, #settings-button, #settings-modal, #onboarding, #onboarding-skip, #onboarding-start'),
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
