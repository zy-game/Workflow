import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import {
  type Actor,
  type PermissionRequest,
  type PermissionService,
  type PolicyRule,
} from '@qingmei/core'
import * as permissionPlugin from '../src/index.ts'

const owner: Actor = { id: 'owner', displayName: '主人', role: 'owner' }

function request(action: string, conversation: 'dm' | 'group' = 'dm'): PermissionRequest {
  return { actor: owner, channel: 'web', conversation, action }
}

async function setup(config: Parameters<typeof permissionPlugin.apply>[1] = {}): Promise<PermissionService> {
  const ctx = new Context()
  await ctx.plugin(permissionPlugin, config)
  const permission = ctx.reflect.get('permission', false) as PermissionService | undefined
  assert.ok(permission, '应注册 permission 服务')
  return permission
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(permissionPlugin.name, 'provider-permission-static')
  assert.deepEqual(permissionPlugin.inject, [])
})

test('私聊里当前全部日程/记忆工具都放行', async () => {
  const permission = await setup()
  for (const tool of [
    'memory_recall',
    'memory_remember',
    'schedule_create',
    'schedule_update',
    'schedule_cancel',
    'schedule_pause',
    'schedule_resume',
    'schedule_list',
    'qm_report_progress',
    'qm_finish_task',
  ]) {
    const decision = await permission.check(request(`tool.invoke:${tool}`))
    assert.equal(decision.effect, 'allow', `${tool} 在私聊里应放行`)
  }
})

test('群聊里拒绝日程与写记忆，并给出人话理由', async () => {
  const permission = await setup()

  const schedule = await permission.check(request('tool.invoke:schedule_list', 'group'))
  assert.equal(schedule.effect, 'deny')
  assert.equal(schedule.effect === 'deny' && schedule.reason, '群聊里不能读或改你的日程')

  const remember = await permission.check(request('tool.invoke:memory_remember', 'group'))
  assert.equal(remember.effect === 'deny' && remember.reason, '群聊里不能写入你的记忆')

  const recall = await permission.check(request('tool.invoke:memory_recall', 'group'))
  assert.equal(recall.effect, 'allow', '群聊里仍可召回公共记忆')
})

test('未登记的动作默认拒绝（全局默认 deny）', async () => {
  const permission = await setup()
  const decision = await permission.check(request('tool.invoke:shell'))
  assert.equal(decision.effect, 'deny')
  assert.match(decision.effect === 'deny' ? decision.reason : '', /未配置策略/)
})

test('risk=dangerous 走「需要确认」，不是直接放行', async () => {
  const permission = await setup({ toolRisk: { schedule_create: 'dangerous' } })
  const decision = await permission.check(request('tool.invoke:schedule_create'))
  assert.equal(decision.effect, 'ask')
  assert.match(decision.effect === 'ask' ? decision.prompt : '', /需要主人确认/)
})

test('显式 deny 优先于工具风险与群聊默认', async () => {
  const permission = await setup({
    rules: [{ match: 'tool.invoke:memory_', effect: 'deny', reason: '暂不允许模型写记忆' }],
  })
  const dm = await permission.check(request('tool.invoke:memory_remember'))
  assert.equal(dm.effect === 'deny' && dm.reason, '暂不允许模型写记忆')

  const group = await permission.check(request('tool.invoke:memory_remember', 'group'))
  assert.equal(group.effect === 'deny' && group.reason, '暂不允许模型写记忆', '显式 deny 的理由应优先于群聊默认理由')
})

test('addRule 生效且可撤销', async () => {
  const permission = await setup()
  const rule: PolicyRule = { match: 'tool.invoke:schedule_create', effect: 'deny', reason: '今天先不加日程' }
  const dispose = permission.addRule(rule)

  const denied = await permission.check(request('tool.invoke:schedule_create'))
  assert.equal(denied.effect === 'deny' && denied.reason, '今天先不加日程')
  assert.ok(permission.rules().some((entry) => entry === rule))

  dispose()
  const allowed = await permission.check(request('tool.invoke:schedule_create'))
  assert.equal(allowed.effect, 'allow')
  assert.ok(!permission.rules().some((entry) => entry === rule))
})

test('defaultEffect 可配置成 allow', async () => {
  const permission = await setup({ defaultEffect: 'allow' })
  assert.equal((await permission.check(request('tool.invoke:shell'))).effect, 'allow')
})
