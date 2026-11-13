import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as portraitPlugin from '../src/index.ts'

async function boot(persona = '默认人格') {
  const dir = mkdtempSync(join(tmpdir(), 'qm-portrait-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'portrait.db') })
  await storeFiber
  const gatewayFiber = ctx.plugin(gatewayPlugin)
  await gatewayFiber
  const portraitFiber = ctx.plugin(portraitPlugin, { persona })
  await portraitFiber
  const portrait = ctx.reflect.get('portrait', false) as {
    self(): Promise<{ persona: string } | null>
    list(kind?: string): Promise<Array<{ id: string; kind: string; name: string }>>
    upsert(input: Record<string, unknown>): Promise<{ id: string; kind: string; persona: string; rules: unknown }>
    group(id: string): Promise<{ rules: { blocked?: string[]; note?: string } } | null>
  }
  return {
    ctx,
    portrait,
    async dispose() {
      await portraitFiber.dispose()
      await gatewayFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('画像：默认 self 从 persona 迁移，可改人格', async () => {
  const h = await boot('初始人格')
  try {
    const self = await h.portrait.self()
    assert.equal(self?.persona, '初始人格')
    await h.portrait.upsert({ kind: 'self', id: 'self', persona: '新人格' })
    assert.equal((await h.portrait.self())?.persona, '新人格')
  } finally {
    await h.dispose()
  }
})

test('画像：群规则可保存并按 conversationId 读取', async () => {
  const h = await boot()
  try {
    await h.portrait.upsert({
      kind: 'group',
      id: 'group:g1',
      name: '测试群',
      rules: { blocked: ['三国', '项目'], requireApproval: true, note: '聊天群，不能提项目' },
    })
    const group = await h.portrait.group('g1')
    assert.ok(group)
    assert.deepEqual(group?.rules.blocked, ['三国', '项目'])
    assert.match(String(group?.rules.note), /不能提项目/)
    const groups = await h.portrait.list('group')
    assert.equal(groups.length, 1)
  } finally {
    await h.dispose()
  }
})
