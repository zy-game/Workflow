import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENDPOINTS } from '../src/lib/endpoints.js'

// 前端改为 Vue 3 后依然没有类型检查，这里继续用静态断言守住两处最容易静默失效的契约：
// 页面请求的接口必须真的被网关注册；导航与 SSE 订阅必须真的覆盖后端事件。
const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')
const REPO = path.resolve(here, '../../..')
const GATEWAY = path.join(REPO, 'packages/host-gateway/src/index.ts')

async function readSource(name: string): Promise<string> {
  return readFile(path.join(SRC, name), 'utf8')
}

test('ENDPOINTS 覆盖核心面板', () => {
  const expected = {
    schedules: './api/v1/schedules',
    tasks: './api/v1/tasks',
    approvals: './api/v1/approvals',
    autonomy: './api/v1/autonomy',
    conversations: './api/v1/conversations',
    incidents: './api/v1/incidents',
    review: './api/v1/review',
    audit: './api/v1/audit',
    persona: './api/v1/persona',
    cost: './api/v1/cost',
    portraits: './api/v1/portraits',
    memoryGraph: './api/v1/memory/graph',
    costRefresh: './api/v1/cost/refresh',
  }
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(ENDPOINTS[key], value, `ENDPOINTS.${key} 应为 ${value}`)
  }
})

test('记忆页订阅候选/画像接口：采纳、恢复、撤回、画像', async () => {
  const view = await readSource('views/MemoriesView.vue')
  for (const key of ['memoryCandidates', 'memoryCandidateDecide', 'memoryCandidateReopen', 'memoryCandidateRollback', 'memoryProfile']) {
    assert.ok(view.includes(`ENDPOINTS.${key}`), `MemoriesView 应调用 ENDPOINTS.${key}`)
  }
  for (const tab of ["tab = 'candidates'", "tab = 'profile'"]) {
    assert.ok(view.includes(tab), `记忆页应有 ${tab} 的页签切换`)
  }
})

test('导航与路由表一致：6 个面板都能落到视图文件', async () => {
  const router = await readSource('router.js')
  const nav = [
    ['/', 'ChatView.vue'],
    ['/workbench', 'WorkbenchView.vue'],
    ['/portraits', 'PortraitView.vue'],
    ['/memories', 'MemoryGraphView.vue'],
    ['/cost', 'CostView.vue'],
    ['/settings', 'SettingsView.vue'],
  ]
  for (const [route, view] of nav) {
    assert.ok(router.includes(`'${route}'`), `router.js 缺少路由 ${route}`)
    assert.ok(router.includes(view), `router.js 缺少视图 ${view}`)
    await access(path.join(SRC, 'views', view))
  }
  assert.equal((router.match(/name: '/g) ?? []).length, nav.length, '每条导航都应有对应的具名路由')
})

test('SSE 订阅覆盖任务、审批与主动事件', async () => {
  const sse = await readSource('lib/sse.js')
  for (const event of ['task-started', 'task-progress', 'task-finished', 'approval-requested', 'approval-decided', 'autonomy-tick']) {
    assert.ok(sse.includes(`'${event}'`), `sse.js 应订阅 ${event}`)
  }
  assert.match(sse, /searchParams\.set\('token'/, 'EventSource 的令牌应走 query')
})

test('网关仍提供登录、会话与事件流入口', async () => {
  const gateway = await readFile(GATEWAY, 'utf8')
  assert.match(gateway, /pathname === '\/api\/v1\/login'/, '网关应提供 POST /api/v1/login')
  assert.match(gateway, /pathname === '\/api\/v1\/session'/, '网关应提供 GET /api/v1/session')
  assert.match(gateway, /pathname === '\/api\/v1\/events'/, '网关应提供 SSE /api/v1/events')
})

test('移动端菜单收进抽屉：青梅开关、遮罩与菜单项都能收起', async () => {
  const app = await readSource('App.vue')
  assert.match(app, /class="topbar"/, 'App.vue 应有移动端顶栏')
  assert.match(app, /drawer-trigger/, '顶栏「青梅」应是抽屉开关')
  assert.match(app, /:aria-expanded="drawerOpen"/, '开关应暴露抽屉展开状态')
  assert.match(app, /class="drawer-scrim"/, '抽屉应有空白遮罩')
  assert.match(app, /@click="closeDrawer\(\)"/, '遮罩与菜单项应能收起抽屉')

  const css = await readSource('style.css')
  assert.match(css, /\.drawer-open \.sidebar/, '移动端应有抽屉展开样式')
  assert.match(css, /\.drawer-open \.drawer-scrim/, '移动端应有遮罩显隐样式')
})

test('入口契约：Vue 挂载点、config.js 与登录门都在', async () => {
  const index = await readFile(path.join(REPO, 'apps/web/index.html'), 'utf8')
  assert.match(index, /id="app"/, 'index.html 应有 Vue 挂载点')
  assert.match(index, /src="\/config.js"/, 'index.html 应加载移动端配置')
  assert.match(index, /src="\/src\/main.js"/, 'index.html 应加载 Vue 入口')

  const app = await readSource('App.vue')
  assert.match(app, /router-view/, 'App.vue 应渲染路由视图')
  assert.match(app, /LoginModal/, 'App.vue 应包含登录门')
  assert.match(app, /connect\(\)/, 'App.vue 启动后应连接 SSE')

  const session = await readSource('lib/session.js')
  assert.match(session, /qm\.token/, '令牌键名应与旧版一致')
  assert.match(session, /__QM_PERSIST_TOKEN__/, '持久化开关应与旧版一致')
})


test('用量面板订阅成本接口：余额、今日花费与 embedding 用量', async () => {
  const view = await readSource('views/CostView.vue')
  for (const key of ['cost', 'costRefresh']) {
    assert.ok(view.includes(`ENDPOINTS.${key}`), `CostView 应调用 ENDPOINTS.${key}`)
  }
  for (const label of ['余额', '今日花费', 'embedding 今日', 'embedding 本月']) {
    assert.ok(view.includes(label), `用量页应有「${label}」`)
  }
})

