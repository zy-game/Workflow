<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { describeFailure, request } from '../lib/api.js'
import { on } from '../lib/bus.js'
import { session, hasAuth } from '../lib/session.js'
import { textOf } from '../lib/sse.js'

defineOptions({ name: 'ChatView' })

const STICK_TO_BOTTOM_PX = 120
const SEND_RETRY_MS = 2000

const messages = ref([])
const input = ref('')
const box = ref(null)
const textarea = ref(null)
const sending = ref(false)
const failed = ref(false)
const retryAt = ref(0)
const noticeText = ref('')
const listening = ref(false)
const nativeSpeech = () => window.Capacitor?.Plugins?.QmSpeech
const voiceSupported = computed(() => Boolean(window.SpeechRecognition || window.webkitSpeechRecognition || nativeSpeech()))
let retryTimer = 0
let counter = 0
let current = null
let historyLoaded = false
let unsubscribers = []
let recognition = null
let nativeHandles = []

const overlayAvailable = computed(() => Boolean(window.Capacitor?.Plugins?.PetOverlay))
const sendDisabled = computed(() => !hasAuth() || sending.value || Date.now() < retryAt.value)
const sendText = computed(() => {
  if (!hasAuth()) return '发送'
  if (sending.value) return '发送中…'
  if (Date.now() < retryAt.value) return '稍候…'
  return failed.value ? '重试' : '发送'
})

function isNearBottom() {
  const node = box.value
  if (!node) return true
  return node.scrollHeight - node.scrollTop - node.clientHeight < STICK_TO_BOTTOM_PX
}

async function stickToBottom(force = false) {
  const stick = force || isNearBottom()
  await nextTick()
  if (stick && box.value) box.value.scrollTop = box.value.scrollHeight
}

function appendMessage(role, text = '') {
  const message = { id: ++counter, role, text, streaming: false, quickReplies: [] }
  messages.value.push(message)
  return message
}

function appendNotice(text) {
  appendMessage('notice', text)
  void stickToBottom()
}

function quickReplyLabels(text) {
  if (!/请选一个：|选项：/.test(text)) return []
  return text.includes('请选一个：')
    ? ['重排期', '降范围', '现在做 30 分钟']
    : ['现在做 30 分钟', '重排期', '降范围']
}

function notifyMobile(text) {
  const plugin = window.Capacitor?.Plugins?.LocalNotifications
  if (!plugin || !document.hidden || !text) return
  void plugin
    .schedule({
      notifications: [
        {
          id: Math.floor(Date.now() % 2147483647),
          title: '青梅',
          body: text.slice(0, 120),
        },
      ],
    })
    .catch(() => undefined)
}

function handleChunk(payload) {
  const text = textOf(payload)
  if (!text) return
  const stick = isNearBottom()
  if (!current) current = appendMessage('assistant')
  current.text += text
  current.streaming = true
  if (stick) void stickToBottom(true)
}

function handleAssistant(payload) {
  const text = textOf(payload)
  const stick = isNearBottom()
  if (!current) current = appendMessage('assistant')
  current.text = text || current.text || '（空回复）'
  current.streaming = false
  current.quickReplies = quickReplyLabels(current.text)
  notifyMobile(current.text)
  current = null
  if (stick) void stickToBottom(true)
}

async function loadHistory() {
  if (historyLoaded) return
  historyLoaded = true
  let rows
  try {
    const res = await request(ENDPOINTS.messages, { query: { conversationId: 'owner', limit: 50 } })
    if (!res.ok) return
    rows = await res.json()
  } catch {
    return // 历史拉不到不影响继续对话
  }
  if (!Array.isArray(rows) || rows.length === 0) return
  for (const row of rows) {
    const role = row?.role === 'user' ? 'user' : 'assistant'
    const text =
      typeof row?.text === 'string' ? row.text : typeof row?.content === 'string' ? row.content : ''
    if (!text) continue
    appendMessage(role, text)
  }
  void stickToBottom(true)
}

async function sendMessage(text) {
  if (!hasAuth()) {
    appendNotice('缺少访问令牌，无法发送')
    return
  }
  if (sending.value || Date.now() < retryAt.value) return

  sending.value = true
  input.value = ''
  resize()
  appendMessage('user', text)
  if (current) current.streaming = false
  current = null
  await stickToBottom(true)

  try {
    const res = await request(ENDPOINTS.messages, {
      method: 'POST',
      body: { text, deviceId: 'web' },
    })
    if (!res.ok) throw new Error(describeFailure(res))
    sending.value = false
    failed.value = false
    textarea.value?.focus()
  } catch (error) {
    sending.value = false
    failed.value = true
    const detail = error instanceof TypeError ? '网络错误，消息没有送达' : error.message || '发送失败'
    appendNotice(detail)
    if (!input.value.trim()) {
      input.value = text
      resize()
    }
    retryAt.value = Date.now() + SEND_RETRY_MS
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryAt.value = 0
      textarea.value?.focus()
    }, SEND_RETRY_MS)
  }
}

function applyTranscript(text) {
  if (!text) return
  input.value = text
  resize()
}

async function startNativeVoice(plugin) {
  if (nativeHandles.length === 0) {
    nativeHandles = [
      await plugin.addListener('partial', (data) => applyTranscript(data?.text)),
      await plugin.addListener('result', (data) => {
        applyTranscript(data?.text)
        listening.value = false
      }),
      await plugin.addListener('speechEnd', () => { listening.value = false }),
      await plugin.addListener('error', (data) => {
        listening.value = false
        appendNotice(`语音识别失败：${data?.message || 'unknown'}`)
      }),
    ]
  }
  listening.value = true
  await plugin.start().catch((error) => {
    listening.value = false
    appendNotice(`语音启动失败：${error?.message || error}`)
  })
}

function toggleVoice() {
  if (listening.value) {
    if (nativeSpeech()) void nativeSpeech().stop()
    else recognition?.stop()
    listening.value = false
    return
  }
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition
  const native = nativeSpeech()
  if (!Speech && !native) {
    appendNotice('当前环境不支持系统语音识别')
    return
  }
  if (native) {
    void startNativeVoice(native)
    return
  }
  recognition = new Speech()
  recognition.lang = 'zh-CN'
  recognition.interimResults = true
  recognition.continuous = false
  recognition.onstart = () => { listening.value = true }
  recognition.onend = () => { listening.value = false }
  recognition.onerror = (event) => {
    listening.value = false
    appendNotice(`语音识别失败：${event.error || 'unknown'}`)
  }
  recognition.onresult = (event) => {
    let text = ''
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      text += event.results[index][0]?.transcript ?? ''
    }
    applyTranscript(text)
  }
  recognition.start()
}
function submit() {
  if (sendDisabled.value) return
  const text = input.value.trim()
  if (!text) return
  void sendMessage(text)
}

function onKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}

function resize() {
  const node = textarea.value
  if (!node) return
  node.style.height = 'auto'
  node.style.height = `${Math.min(node.scrollHeight, 160)}px`
}

function sendQuick(message, label) {
  message.quickReplies = []
  void sendMessage(label)
}

async function startOverlay() {
  const overlay = window.Capacitor?.Plugins?.PetOverlay
  if (!overlay) return
  try {
    const check = await overlay.canDraw()
    if (!check || !check.granted) {
      await overlay.openSettings()
      appendNotice('打开「显示在其他应用上层」后再点悬浮。')
      return
    }
    await overlay.start()
  } catch (error) {
    appendNotice(error?.message || '悬浮启动失败')
  }
}

function subscribe() {
  unsubscribers = [
    on('chunk', handleChunk),
    on('assistant', handleAssistant),
    on('notice', (text) => appendNotice(text || '服务端返回错误')),
  ]
}

onMounted(() => {
  subscribe()
  resize()
  if (session.authReady) void loadHistory()
})

watch(
  () => session.authReady,
  (ready) => {
    if (ready) void loadHistory()
  },
)

onBeforeUnmount(() => {
  for (const off of unsubscribers) off()
  clearTimeout(retryTimer)
  recognition?.stop()
  if (nativeSpeech()) void nativeSpeech().cancel()
  for (const handle of nativeHandles) handle?.remove?.()
  nativeHandles = []
})
</script>

<template>
  <section class="chat">
    <header class="chat-head">
      <div>
        <h2 class="view-title">对话</h2>
        <p class="view-sub">一条消息就是一轮；提醒、记忆、任务都可以在这里直接说。</p>
      </div>
      <button v-if="overlayAvailable" class="btn ghost small" type="button" @click="startOverlay">悬浮到桌面</button>
    </header>

    <div ref="box" class="messages" role="log" aria-live="polite" aria-relevant="additions text">
      <p v-if="messages.length === 0" class="empty">说点什么吧。先从一句「今天有什么要处理的」开始。</p>
      <article v-for="message in messages" :key="message.id" class="msg" :class="`msg-${message.role}`">
        <span class="msg-role">{{ message.role === 'user' ? '你' : message.role === 'notice' ? '提示' : '青梅' }}</span>
        <div v-if="message.role === 'notice'" class="notice" role="alert">{{ message.text }}</div>
        <div v-else class="bubble" :class="{ 'is-streaming': message.streaming }">{{ message.text }}</div>
        <div v-if="message.quickReplies.length" class="quick-replies">
          <button v-for="label in message.quickReplies" :key="label" type="button" @click="sendQuick(message, label)">
            {{ label }}
          </button>
        </div>
      </article>
    </div>

    <form class="composer" autocomplete="off" @submit.prevent="submit">
      <label class="sr-only" for="chat-input">消息</label>
      <textarea
        id="chat-input"
        ref="textarea"
        v-model="input"
        class="input"
        rows="1"
        maxlength="8000"
        placeholder="给青梅发消息…"
        enterkeyhint="send"
        @keydown="onKeydown"
        @input="resize"
      ></textarea>
      <button v-if="voiceSupported" class="mic" :class="{ listening }" type="button" :aria-label="listening ? '停止语音输入' : '语音输入'" @click="toggleVoice">
        {{ listening ? '听…' : '语音' }}
      </button>
      <button class="send" type="submit" :disabled="sendDisabled">{{ sendText }}</button>
    </form>
  </section>
</template>
