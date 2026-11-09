/**
 * 概念审查页真实浏览器测试：Chrome CDP + 生产页面。
 *
 * 需要先启动：
 *   chrome --headless=new --remote-debugging-port=9223 ...
 * 运行：
 *   QM_URL=https://... QM_TOKEN=... node scripts/browser-test-memories.mjs
 */
import { writeFileSync } from 'node:fs'

const cdp = 'http://127.0.0.1:9223'
const base = String(process.env.QM_URL ?? 'http://127.0.0.1:7410').replace(/\/+$/, '')
const token = String(process.env.QM_TOKEN ?? '')
const url = `${base}/?token=${encodeURIComponent(token)}#/memories`

const target = await fetch(`${cdp}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((res) => res.json())
const ws = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 1
const events = []

ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  } else if (message.method) {
    events.push(message.method)
  }
})

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result.result?.value
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url })
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const initial = await evaluate(`({
    title: document.title,
    text: document.body.innerText.slice(0, 1200),
    buttons: [...document.querySelectorAll('button')].map((button) => button.textContent.trim()),
  })`)

  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('概念提案'))
    if (!button) return false
    button.click()
    return true
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const concepts = await evaluate(`({
    text: document.body.innerText.slice(0, 2200),
    items: document.querySelectorAll('.list .item').length,
    hasSummary: document.body.innerText.includes('神经元'),
    hasProposals: document.body.innerText.includes('概念提案'),
    hasHistory: document.body.innerText.includes('最近概念变更'),
    buttons: [...document.querySelectorAll('button')].map((button) => button.textContent.trim()),
  })`)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const screenshot = 'browser-memories.png'
  writeFileSync(screenshot, Buffer.from(shot.data, 'base64'))

  const report = { url: base, clicked, initial, concepts, screenshot, events: events.slice(0, 20) }
  console.log(JSON.stringify(report, null, 2))
  if (!clicked) throw new Error('没有找到概念提案按钮')
  if (!concepts.hasSummary || !concepts.hasProposals) throw new Error('记忆页未渲染概念审查内容')
  if (concepts.items === 0) throw new Error('概念列表为空')
} finally {
  try { await send('Browser.close') } catch { /* ignore */ }
  ws.close()
}
