import { readFileSync } from 'node:fs'
const expression = readFileSync('tmp-eval.js', 'utf8')
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/3CFE64C1815FA85B0BE2E195FF2363FD')
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 1
function send(method, params) {
  return new Promise((resolve) => {
    const id = seq++
    const handler = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === id) { ws.removeEventListener('message', handler); resolve(message) }
    }
    ws.addEventListener('message', handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
console.log(JSON.stringify(result.result?.result?.value ?? result, null, 2))
ws.close()
