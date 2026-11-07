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
const simple = await send('Runtime.evaluate', { expression: '({ base: window.__QM_SERVER_URL, cap: !!window.Capacitor, native: window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform(), platform: window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform(), plugin: !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.QmUpdater) })', returnByValue: true })
console.log('simple:', JSON.stringify(simple.result?.result?.value ?? simple))
const info = await send('Runtime.evaluate', { expression: 'window.Capacitor.Plugins.QmUpdater.getInfo()', awaitPromise: true, returnByValue: true })
console.log('info:', JSON.stringify(info.result?.result?.value ?? info))
const latest = await send('Runtime.evaluate', { expression: 'fetch(window.__QM_SERVER_URL + "/updates/android/latest.json", { cache: "no-store" }).then(r => r.json())', awaitPromise: true, returnByValue: true })
console.log('latest:', JSON.stringify(latest.result?.result?.value ?? latest))
ws.close()
