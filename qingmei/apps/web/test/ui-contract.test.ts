import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 前端零构建、没有类型检查，所以这里用静态断言守住两处最容易静默失效的契约：
// app.js 引用的 DOM id 必须真的存在于 index.html；请求的接口必须真的被网关注册。
const here = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.resolve(here, '../public')
const GATEWAY = path.resolve(here, '../../../packages/host-gateway/src/index.ts')

async function readPublic(name: string): Promise<string> {
  return readFile(path.join(PUBLIC, name), 'utf8')
}

test('app.js 引用的每个 DOM id 都存在于 index.html', async () => {
  const script = await readPublic('app.js')
  const html = await readPublic('index.html')

  const ids = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]!)
  assert.ok(ids.length >= 10, `app.js 的 getElementById 数量异常：${ids.length}`)

  for (const id of new Set(ids)) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html 缺少 #${id}`)
  }
})

test('app.js 请求的日程接口与网关注册的路由一致', async () => {
  const script = await readPublic('app.js')
  const gateway = await readFile(GATEWAY, 'utf8')

  assert.match(script, /schedules: '\.\/api\/v1\/schedules'/, 'app.js 应把日程接口写在 ENDPOINTS 里')
  assert.match(script, /method: 'DELETE'/, '取消日程应使用 DELETE')
  assert.match(script, /method: 'PATCH'/, '编辑日程应使用 PATCH')
  assert.match(script, /'pause' : 'resume'/, '暂停/继续应打到 /pause 与 /resume')
  assert.match(gateway, /pathname === '\/api\/v1\/schedules'/, '网关应注册 GET /api/v1/schedules')
  assert.match(gateway, /pathname\.startsWith\('\/api\/v1\/schedules\/'\) && method === 'PATCH'/, '网关应注册 PATCH')
  assert.match(gateway, /pathname\.startsWith\('\/api\/v1\/schedules\/'\) && method === 'DELETE'/, '网关应注册 DELETE')
  assert.match(gateway, /\(pause\|resume\)/, '网关应识别 /pause 与 /resume')
})
