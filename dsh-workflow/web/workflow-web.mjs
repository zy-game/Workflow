// workflow-web.mjs - DSH host plugin that grafts the Workflow desktop web
// client onto the DSH web surface:
//   - proxies /workflow/* to Workflow Core so the embedded app runs
//     same-origin (no CORS, no per-browser quirks);
//   - serves /workflow/client.js, a self-contained script that adds a
//     floating "Workflow" button opening the app full-screen;
//   - taps the served index.html to load that script.
// Enable from server-patch.yml:
//   - insert:
//       - id: workflow-web
//         name: 'file:///home/ubuntu/.dsh/plugins/workflow-web.mjs'
//         config:
//           coreUrl: 'http://127.0.0.1:8710'
//           clientScript: '/home/ubuntu/.dsh/plugins/workflow-client.js'
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import z from '@deepseek-ai/schemastery';

export const name = 'workflow-web'
export const inject = ['webServer']

const Config = z.object({
  coreUrl: z.string().required(),
  clientScript: z.string().required(),
})

const PREFIX = '/workflow'

export function createWorkflowWeb(config = {}) {
  const cfg = Config(config)
  const core = cfg.coreUrl.replace(/\/+$/, '')

  // /workflow -> Core /;  /workflow/foo -> Core /foo (query preserved).
  function toTarget(reqUrl) {
    const raw = new URL(reqUrl ?? '/', 'http://internal')
    const suffix = raw.pathname === PREFIX || raw.pathname === `${PREFIX}/` ? '/' : `${raw.pathname.slice(PREFIX.length) || '/'}`
    return new URL(`${suffix}${raw.search}`, `${core}/`)
  }

  function proxy(req, res) {
    const target = toTarget(req.url)
    const headers = { ...req.headers }
    delete headers.host
    delete headers.connection
    delete headers['content-length']
    const upstream = http.request(target, {
      method: req.method,
      headers: { ...headers, host: new URL(core).host },
    })
    upstream.on('response', (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'workflow_core_unreachable', error: String(error?.message ?? error) }))
    })
    req.pipe(upstream)
  }

  async function serveClientScript(res) {
    try {
      const body = await readFile(cfg.clientScript, 'utf8')
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`workflow-web: cannot read clientScript: ${error?.message ?? error}`)
    }
  }

  function tapIndex(html) {
    if (html.includes('/workflow/client.js')) return html
    return html.replace(/<\/body>/i, '<script src="/workflow/client.js" defer></script></body>')
  }

  return { proxy, serveClientScript, tapIndex, toTarget, core }
}

export function apply(ctx, config = {}) {
  const web = createWorkflowWeb(config)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREFIX,
    handler: (req, res) => web.proxy(req, res),
  }), 'workflow-web: entry')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${PREFIX}/client.js`,
    handler: (_req, res) => web.serveClientScript(res),
  }), 'workflow-web: client script')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${PREFIX}/`,
    handler: (req, res) => web.proxy(req, res),
  }), 'workflow-web: core proxy')
  ctx.effect(() => ctx.webServer.tapIndex((html) => web.tapIndex(html)), 'workflow-web: index script injection')
}
