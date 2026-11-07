import { readFileSync } from 'node:fs'
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/3CFE64C1815FA85B0BE2E195FF2363FD')
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 1
const events = []
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
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.consoleAPICalled') {
    events.push({ type: 'console', level: message.params.type, text: message.params.args.map((a) => a.value ?? a.description).join(' ') })
  }
  if (message.method === 'Runtime.exceptionThrown') {
    events.push({ type: 'exception', text: message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text })
  }
})
await send('Runtime.enable', {})
await send('Page.enable', {})
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__qmFetches = []; const origFetch = window.fetch; window.fetch = function(...args) { const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url); const rec = { url, at: Date.now() }; window.__qmFetches.push(rec); return origFetch.apply(this, args).then((res) => { rec.status = res.status; return res; }, (err) => { rec.error = String(err); throw err; }); }; window.addEventListener('error', (e) => { window.__qmError = String(e.message); }); window.addEventListener('unhandledrejection', (e) => { window.__qmRejection = String(e.reason && e.reason.message || e.reason); });`,
})
await send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 9000))
const expression = readFileSync('tmp-eval2.js', 'utf8')
const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
console.log('RESULT', JSON.stringify(result.result?.result?.value ?? result, null, 2))
console.log('EVENTS', JSON.stringify(events.slice(-20), null, 2))
ws.close()
