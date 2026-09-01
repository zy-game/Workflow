// web-plugin.test.mjs - the workflow-web DSH host plugin: route/table
// registration, index injection, client script serving, and the same-origin
// proxy path mapping (exercised over real HTTP both sides).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { apply, createWorkflowWeb } from '../web/workflow-web.mjs'

function fakeCtx() {
  const routes = []
  const taps = []
  const effects = []
  const ctx = {
    routes,
    webServer: {
      register(route) { routes.push(route) },
      tapIndex(transform) { taps.push(transform) },
      renderIndex: (html) => html,
    },
    effect(fn, reason) {
      effects.push(reason)
      fn()
    },
  }
  return { ctx, routes, taps, effects }
}

test('workflow-web registers entry, script, proxy routes and an index tap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-web-plugin-'))
  const script = path.join(dir, 'client.js')
  fs.writeFileSync(script, '/* bundle */')
  const { ctx, routes, taps, effects } = fakeCtx()

  apply(ctx, { coreUrl: 'http://127.0.0.1:8710', clientScript: script })

  assert.deepEqual(routes.map((route) => [route.kind, route.path]), [
    ['exact', '/workflow'],
    ['prefix', '/workflow/client.js'],
    ['prefix', '/workflow/'],
  ])
  assert.equal(taps.length, 1)
  assert.deepEqual(effects, [
    'workflow-web: entry',
    'workflow-web: client script',
    'workflow-web: core proxy',
    'workflow-web: index script injection',
  ])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('index tap injects the loader script once', () => {
  const web = createWorkflowWeb({ coreUrl: 'http://127.0.0.1:8710', clientScript: 'x' })
  const page = '<html><head></head><body><div id=app></div></body></html>'
  const once = web.tapIndex(page)
  assert.ok(once.includes('<script src="/workflow/client.js" defer></script></body>'))
  assert.equal(web.tapIndex(once), once)
})

test('proxy maps the /workflow prefix onto the Core origin', () => {
  const web = createWorkflowWeb({ coreUrl: 'http://core.example:8710/', clientScript: 'x' })
  assert.equal(web.toTarget('/workflow').toString(), 'http://core.example:8710/')
  assert.equal(web.toTarget('/workflow/').toString(), 'http://core.example:8710/')
  assert.equal(web.toTarget('/workflow/api/v1/tasks?limit=5').toString(), 'http://core.example:8710/api/v1/tasks?limit=5')
})

test('proxy pipes browser requests to Core with rewritten paths', async () => {
  const seen = []
  const core = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, host: req.headers.host })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, method: req.method }))
  })
  await new Promise((resolve) => core.listen(0, '127.0.0.1', resolve))
  const coreUrl = `http://127.0.0.1:${core.address().port}`

  const web = createWorkflowWeb({ coreUrl, clientScript: 'x' })
  const surface = http.createServer((req, res) => web.proxy(req, res))
  await new Promise((resolve) => surface.listen(0, '127.0.0.1', resolve))

  try {
    const through = async (path) => {
      const response = await fetch(`http://127.0.0.1:${surface.address().port}${path}`)
      return { status: response.status, body: await response.json() }
    }
    const entry = await through('/workflow')
    assert.equal(entry.body.url, '/')
    const api = await through('/workflow/api/v1/tasks?limit=5')
    assert.equal(api.body.url, '/api/v1/tasks?limit=5')
    assert.equal(api.body.method, 'GET')
    assert.ok(seen.every((row) => row.host.startsWith('127.0.0.1:')), 'upstream host header must be the Core origin')
  } finally {
    await new Promise((resolve) => surface.close(resolve))
    await new Promise((resolve) => core.close(resolve))
  }
})

test('client auth state is reactive and invalid sessions return to login', () => {
  const root = path.dirname(fileURLToPath(import.meta.url))
  const client = fs.readFileSync(path.join(root, '../web/@workflow/dsh-web/lib/client.js'), 'utf8')
  assert.match(client, /var authListeners = new Set\(\)/)
  assert.match(client, /function useAuth\(\)/)
  assert.match(client, /resp\.status === 401 && tk/)
  assert.match(client, /setActivePage\(null\)/)
  assert.match(client, /client-session/)
  assert.match(client, /client-logout/)
})

test('client script route serves the configured file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-web-client-'))
  const script = path.join(dir, 'client.js')
  fs.writeFileSync(script, 'window.__WORKFLOW_CLIENT__ = true;')
  const web = createWorkflowWeb({ coreUrl: 'http://127.0.0.1:8710', clientScript: script })

  let status = null
  let type = null
  let body = ''
  const res = {
    writeHead(code, headers) { status = code; type = headers['content-type'] },
    end(chunk) { body = chunk },
  }
  await web.serveClientScript(res)
  assert.equal(status, 200)
  assert.equal(type, 'text/javascript; charset=utf-8')
  assert.equal(body, 'window.__WORKFLOW_CLIENT__ = true;')
  fs.rmSync(dir, { recursive: true, force: true })
})
