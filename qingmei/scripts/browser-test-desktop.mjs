/**
 * 桌面 renderer 视觉验收（Chrome CDP）：
 * - 不依赖 Electron 主进程
 * - 断言状态点/顶部拖动条已移除
 * - 切到 offline 睡眠动画并截图
 */
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const cdp = 'http://127.0.0.1:9223'
const file = pathToFileURL('E:/Workflow/qingmei/apps/desktop/renderer/index.html').href
const target = await fetch(`${cdp}/json/new?${encodeURIComponent(file)}`, { method: 'PUT' }).then((res) => res.json())
const ws = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 1
ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
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
  await send('Page.navigate', { url: file })
  await new Promise((resolve) => setTimeout(resolve, 1800))
  const result = await evaluate(`(async () => {
    document.getElementById('onboarding').hidden = true
    document.getElementById('settings-modal').hidden = true
    const video = document.getElementById('pet')
    video.src = './assets/webm/sleep.webm'
    video.loop = true
    await video.play().catch(() => undefined)
    document.getElementById('app').dataset.state = 'offline'
    await new Promise((resolve) => setTimeout(resolve, 600))
    return {
      statusDot: Boolean(document.getElementById('status-dot')),
      dragHandle: Boolean(document.getElementById('drag-handle')),
      state: document.getElementById('app').dataset.state,
      src: video.getAttribute('src'),
      text: document.body.innerText.slice(0, 400),
    }
  })()`)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const screenshot = 'desktop-offline.png'
  writeFileSync(screenshot, Buffer.from(shot.data, 'base64'))
  console.log(JSON.stringify({ ...result, screenshot }, null, 2))
  if (result.statusDot || result.dragHandle) throw new Error('状态点或顶部拖动条仍然存在')
  if (result.state !== 'offline' || !String(result.src).includes('sleep')) throw new Error('离线睡眠状态未生效')
} finally {
  try { await send('Browser.close') } catch { /* ignore */ }
  ws.close()
}
