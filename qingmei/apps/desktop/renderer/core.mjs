/**
 * 桌面宿主的核心纯逻辑：SSE 解析、事件转气泡、气泡队列。
 * 不依赖 DOM/Electron，node --test 可直接覆盖。
 */

export class SseParser {
  constructor() {
    this.buffer = ''
  }

  /** 喂一段文本，返回本次能完整解析出的事件（可能 0..n 个） */
  push(chunk) {
    this.buffer += String(chunk ?? '').replace(/\r\n/g, '\n')
    const events = []
    let index = this.buffer.indexOf('\n\n')
    while (index >= 0) {
      const raw = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      const parsed = parseBlock(raw)
      if (parsed) events.push(parsed)
      index = this.buffer.indexOf('\n\n')
    }
    return events
  }
}

function parseBlock(raw) {
  let event = 'message'
  const data = []
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon >= 0 ? line.slice(0, colon) : line
    const value = colon >= 0 ? line.slice(colon + 1).replace(/^ /, '') : ''
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

/** 从 OutboundEnvelope 的 blocks 里取纯文本 */
export function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image' && typeof block.alt === 'string') parts.push(`[图片] ${block.alt}`)
  }
  return parts.join('\n').trim()
}

/**
 * 把一条 SSE 事件转成桌宠气泡。返回 null 表示这条事件不该打扰用户。
 * 目前订阅：assistant（所有主动/回复消息）、approval-requested、task-finished（失败）。
 */
export function bubbleForEvent(event) {
  const type = event?.event
  const data = parseData(event?.data)
  if (type === 'assistant') {
    const envelope = data
    const text = textOfBlocks(envelope?.blocks)
    if (!text) return null
    return { text, kind: 'message', channel: envelope?.channel ?? 'web' }
  }
  if (type === 'approval-requested') {
    const title = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : '有一个操作等你确认'
    return { text: `等你确认：${title}`, kind: 'approval' }
  }
  if (type === 'task-finished') {
    if (data?.status !== 'failed') return null
    const title = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : data?.taskId ?? '任务'
    return { text: `任务失败：${title}`, kind: 'error' }
  }
  return null
}

function parseData(raw) {
  if (typeof raw !== 'string' || !raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 通知气泡队列：一次只显示一个，过期的自动丢掉 */
export class BubbleQueue {
  constructor({ ttlMs = 9000, clock = () => Date.now(), max = 20 } = {}) {
    this.ttlMs = ttlMs
    this.clock = clock
    this.max = max
    this.items = []
  }

  add(text, kind = 'message') {
    const clean = String(text ?? '').trim()
    if (!clean) return null
    const item = { id: `${this.clock()}-${this.items.length}-${Math.random().toString(36).slice(2, 6)}`, text: clean, kind, at: this.clock() }
    this.items.push(item)
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max)
    return item
  }

  current() {
    this.prune()
    return this.items[0] ?? null
  }

  dismiss() {
    this.prune()
    return this.items.shift() ?? null
  }

  prune() {
    const now = this.clock()
    this.items = this.items.filter((item) => now - item.at < this.ttlMs)
  }

  get size() {
    return this.items.length
  }
}

/** 把服务器地址规整成不带尾斜杠的 http(s) URL；非法返回 null */
export function normalizeServerUrl(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** SSE 的 EventSource 不能带 header，令牌只能放 query */
export function eventsUrl(serverUrl, token) {
  const base = normalizeServerUrl(serverUrl)
  if (!base) return null
  const url = new URL(`${base}/api/v1/events`)
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

/** 历史消息（qm_message 行）转渲染用的 {role,text} */
export function mapHistory(rows) {
  if (!Array.isArray(rows)) return []
  return rows
    .map((row) => {
      const role = row?.role === 'assistant' ? 'assistant' : row?.role === 'user' ? 'user' : ''
      const text = typeof row?.text === 'string' ? row.text.trim() : ''
      return role && text ? { role, text } : null
    })
    .filter(Boolean)
}
