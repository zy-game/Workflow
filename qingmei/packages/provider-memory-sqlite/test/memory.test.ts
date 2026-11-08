import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as historyPlugin from '@qingmei/qm-history'
import * as memoryPlugin from '../src/index.ts'
import type { MemoryRecord } from '@qingmei/core'

const ORIGIN: MemoryRecord['origin'] = { kind: 'channel', id: 's_owner' }

function fact(subject: string, predicate: string, object: string, confidence = 0.9): MemoryRecord {
  return { kind: 'fact', subject, predicate, object, confidence, sensitivity: 'private', origin: ORIGIN }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-mem-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'memory.db') })
  await storeFiber
  const historyFiber = ctx.plugin(historyPlugin)
  await historyFiber
  const memoryFiber = ctx.plugin(memoryPlugin, { limit: 5 })
  await memoryFiber
  return {
    ctx,
    async dispose() {
      await memoryFiber.dispose()
      await historyFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('ingest：写入事实，重复三元组合并而非新增', async () => {
  const { ctx, dispose } = await setup()
  try {
    const first = await ctx.memory.ingest([fact('主人', '下周三要去', '杭州')])
    assert.equal(first.created.length, 1)
    const second = await ctx.memory.ingest([fact('主人', '下周三要去', '杭州', 0.95)])
    assert.equal(second.created.length, 0)
    assert.equal(second.merged.length, 1)
  } finally {
    await dispose()
  }
})

test('recall：按关键词命中并格式化为可注入文本', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([fact('主人', '下周三要去', '杭州'), fact('主人', '喜欢', '手冲咖啡')])
    const hit = await ctx.memory.recall({ text: '我下周三去杭州，那边有什么好喝的' })
    assert.ok(hit.facts.length >= 1)
    assert.match(hit.text, /杭州/)
    assert.equal(hit.facts[0]?.subject, '主人')
  } finally {
    await dispose()
  }
})

test('recall：无关查询不返回任何事实', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([fact('主人', '喜欢', '手冲咖啡')])
    const miss = await ctx.memory.recall({ text: '今天天气怎么样' })
    assert.equal(miss.facts.length, 0)
    assert.equal(miss.text, '')
  } finally {
    await dispose()
  }
})

test('forget：软删除后不再召回，且可重复调用', async () => {
  const { ctx, dispose } = await setup()
  try {
    const created = await ctx.memory.ingest([fact('主人', '下周三要去', '杭州')])
    const id = created.created[0]!
    assert.equal(await ctx.memory.forget([id]), 1)
    assert.equal(await ctx.memory.forget([id]), 0)
    const after = await ctx.memory.recall({ text: '杭州' })
    assert.equal(after.facts.length, 0)
  } finally {
    await dispose()
  }
})

test('ingest：低置信度或字段不完整被丢弃', async () => {
  const { ctx, dispose } = await setup()
  try {
    const result = await ctx.memory.ingest([
      fact('主人', '可能喜欢', '某种东西', 0.2),
      fact('', '喜欢', '咖啡'),
    ])
    assert.equal(result.created.length, 0)
    assert.equal(result.merged.length, 0)
  } finally {
    await dispose()
  }
})

test('同一 subject+predicate 的新值软失效旧值', async () => {
  const { ctx, dispose } = await setup()
  try {
    const cat = await ctx.memory.ingest([fact('主人', '养', '猫')])
    const catId = cat.created[0]!
    await ctx.memory.ingest([fact('主人', '养', '狗')])

    const store = ctx.reflect.get('store', false) as {
      collection(name: string): { find(): Promise<Record<string, unknown>[]> }
    }
    const rows = await store.collection('qm_mem_fact').find()
    const catRow = rows.find((row) => row.id === catId)
    assert.ok(catRow)
    assert.equal(typeof catRow.valid_to, 'number')

    const hit = await ctx.memory.recall({ text: '我养什么' })
    assert.equal(hit.facts.length, 1)
    assert.equal(hit.facts[0]?.object, '狗')
  } finally {
    await dispose()
  }
})

test('recall：群聊视口不注入 private/secret/别的 audience', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      { ...fact('主人', '喜欢', '手冲咖啡'), sensitivity: 'private' },
      { ...fact('项目:青梅', '状态', '测试全绿'), sensitivity: 'public', audience: 'group:g1' },
      { ...fact('主人', '手机号', '138'), sensitivity: 'secret' },
    ])

    const owner = await ctx.memory.recall({ text: '咖啡 测试 手机号' })
    assert.deepEqual(owner.facts.map((item) => item.object), ['手冲咖啡'])

    const group = await ctx.memory.recall({ text: '咖啡 测试 手机号', audience: 'group:g1' })
    assert.deepEqual(group.facts.map((item) => item.object), ['测试全绿'])

    const other = await ctx.memory.recall({ text: '测试', audience: 'group:g2' })
    assert.equal(other.facts.length, 0)
  } finally {
    await dispose()
  }
})

test('profile：按 subject 聚合，且群聊为空', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      fact('主人', '喜欢', '手冲咖啡', 0.9),
      fact('主人', '养', '猫', 0.8),
      fact('主人', '养', '狗', 0.95),
      fact('工作', '在', '腾讯', 0.7),
    ])
    const profile = await ctx.memory.profile({ audience: 'owner' })
    const bySubject = new Map(profile.map((entry) => [entry.subject, entry.facts.map((item) => `${item.predicate}${item.object}`)]))
    assert.ok(bySubject.get('主人')?.includes('养狗'))
    assert.equal(bySubject.get('主人')?.some((item) => item.includes('猫')), false)
    assert.ok(bySubject.get('工作')?.includes('在腾讯'))
    assert.deepEqual(await ctx.memory.profile({ audience: 'group:g1' }), [])
  } finally {
    await dispose()
  }
})

test('summarize：从 history 生成会话摘要', async () => {
  const { ctx, dispose } = await setup()
  try {
    const store = ctx.reflect.get('store', false) as {
      collection(name: string): { insert(row: Record<string, unknown>): Promise<unknown> }
    }
    const messages = store.collection('qm_message')
    const now = Date.now()
    await messages.insert({ id: 'm1', role: 'user', text: '明天去杭州出差', session_id: 's_chat', created_at: now - 3000 })
    await messages.insert({ id: 'm2', role: 'assistant', text: '好的，我记下了', session_id: 's_chat', created_at: now - 2000 })
    await messages.insert({ id: 'm3', role: 'user', text: '提醒我带身份证', session_id: 's_chat', created_at: now - 1000 })

    const summary = await ctx.memory.summarize('chat')
    assert.match(summary, /最近 2 轮/)
    assert.match(summary, /杭州出差/)
    assert.match(summary, /带身份证/i)
  } finally {
    await dispose()
  }
})

test('记忆页：listFacts / updateFact 支持人工修正', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([fact('主人', '喜欢', '黑咖啡')])
    const listed = await ctx.memory.listFacts()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.object, '黑咖啡')

    const updated = await ctx.memory.updateFact(listed[0]!.id, { object: '加奶咖啡', salience: 0.9 })
    assert.equal(updated, true)
    const after = await ctx.memory.listFacts()
    assert.equal(after[0]?.object, '加奶咖啡')
    assert.equal(after[0]?.salience, 0.9)
  } finally {
    await dispose()
  }
})
