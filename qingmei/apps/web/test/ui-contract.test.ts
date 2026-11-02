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
const QM_TASK = path.resolve(here, '../../../packages/qm-task/src/index.ts')
const QM_APPROVAL = path.resolve(here, '../../../packages/qm-approval/src/index.ts')
const QM_AUTONOMY = path.resolve(here, '../../../packages/qm-autonomy/src/index.ts')

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

test('任务面板与 qm-task 的路由/事件对得上', async () => {
  const script = await readPublic('app.js')
  const taskPlugin = await readFile(QM_TASK, 'utf8')

  assert.match(script, /tasks: '\.\/api\/v1\/tasks'/, 'app.js 应把任务接口写在 ENDPOINTS 里')
  assert.match(script, /task-progress/, '任务面板应订阅 SSE 的 task-progress')
  assert.match(script, /TASK_STATUS_TEXT/, '任务面板应有状态文案')

  assert.match(taskPlugin, /path: '\/api\/v1\/tasks'/, 'qm-task 应注册 /api/v1/tasks')
  assert.match(taskPlugin, /'task-started'/, 'qm-task 应把 run-started 推到 SSE')
  assert.match(taskPlugin, /'task-progress'/, 'qm-task 应把 progress 推到 SSE')
  assert.match(taskPlugin, /'task-finished'/, 'qm-task 应把 finished 推到 SSE')
})

test('待确认区与 qm-approval 的路由/事件对得上', async () => {
  const script = await readPublic('app.js')
  const approvalPlugin = await readFile(QM_APPROVAL, 'utf8')

  assert.match(script, /approvals: '\.\/api\/v1\/approvals'/, 'app.js 应把审批接口写在 ENDPOINTS 里')
  assert.match(script, /approval-requested/, '面板应订阅 approval-requested')
  assert.match(script, /approvalDecide/, '批准/拒绝应打到 decide 接口')

  assert.match(approvalPlugin, /path: '\/api\/v1\/approvals'/, 'qm-approval 应注册 GET /api/v1/approvals')
  assert.match(approvalPlugin, /path: '\/api\/v1\/approvals\/decide'/, 'qm-approval 应注册 decide')
  assert.match(approvalPlugin, /'approval-requested'/, 'qm-approval 应把请求推到 SSE')
  assert.match(approvalPlugin, /'approval-decided'/, 'qm-approval 应把判定推到 SSE')
})

test('主动面板与 qm-autonomy 的路由/事件对得上', async () => {
  const script = await readPublic('app.js')
  const autonomyPlugin = await readFile(QM_AUTONOMY, 'utf8')

  assert.match(script, /autonomy: '\.\/api\/v1\/autonomy'/, 'app.js 应把自主循环接口写在 ENDPOINTS 里')
  assert.match(script, /autonomy-tick/, '主动面板应订阅 SSE 的 autonomy-tick')
  assert.match(script, /autonomy\/tick/, '应有「立即巡一次」的入口')

  assert.match(autonomyPlugin, /path: '\/api\/v1\/autonomy'/, 'qm-autonomy 应注册 GET /api/v1/autonomy')
  assert.match(autonomyPlugin, /path: '\/api\/v1\/autonomy\/tick'/, 'qm-autonomy 应注册 tick')
  assert.match(autonomyPlugin, /'autonomy-tick'/, 'qm-autonomy 应把每次 tick 推到 SSE')
})
