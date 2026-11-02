import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
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
  const memoryFiber = ctx.plugin(memoryPlugin, { limit: 5 })
  await memoryFiber
  return {
    ctx,
    async dispose() {
      await memoryFiber.dispose()
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
    await ctx.memory.ingest([
      fact('主人', '下周三要去', '杭州'),
      fact('主人', '喜欢', '手冲咖啡'),
    ])
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

test('ingest：低于置信度阈值或字段不完整的记录被丢弃', async () => {
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

test('ingest：同一 subject+predicate 的新值让旧值有效期末尾（软失效，不删除）', async () => {
  const { ctx, dispose } = await setup()
  try {
    const cat = await ctx.memory.ingest([fact('主人', '养', '猫')])
    const catId = cat.created[0]!

    const dog = await ctx.memory.ingest([fact('主人', '养', '狗')])
    assert.equal(dog.created.length, 1, '新值应新增一行')

    // 旧值仍在库里，只是 valid_to 被置位
    const rows = await ctx.store.collection('qm_mem_fact').find({})
    const catRow = rows.find((row) => row.id === catId)
    assert.ok(catRow, '旧事实不应被删除')
    assert.equal(typeof catRow.valid_to, 'number')
    assert.ok(catRow.valid_to > 0)

    const hit = await ctx.memory.recall({ text: '我养什么' })
    assert.equal(hit.facts.length, 1)
    assert.equal(hit.facts[0]?.object, '狗')
  } finally {
    await dispose()
  }
})

test('recall：群聊视口不注入 private，也不注入别的 audience', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      { ...fact('主人', '喜欢', '手冲咖啡'), sensitivity: 'private' },
      { ...fact('项目:青梅', '状态', '测试全绿'), sensitivity: 'public', audience: 'group:g1' },
      { ...fact('主人', '手机号', '138'), sensitivity: 'secret' },
    ])

    const owner = await ctx.memory.recall({ text: '咖啡 测试 手机号' })
    assert.deepEqual(
      owner.facts.map((item) => item.object),
      ['手冲咖啡'],
      '主人视口只给 audience=owner 的非 secret 记忆（secret 永不注入 prompt）',
    )

    const group = await ctx.memory.recall({ text: '咖啡 测试 手机号', audience: 'group:g1' })
    assert.deepEqual(
      group.facts.map((item) => item.object),
      ['测试全绿'],
      '群聊只给该群 public 事实，private/secret 零注入',
    )

    const otherGroup = await ctx.memory.recall({ text: '测试', audience: 'group:g2' })
    assert.equal(otherGroup.facts.length, 0, '别的群看不到 g1 的记忆')
  } finally {
    await dispose()
  }
})

test('profile：按 subject 聚合、只含有效 owner 事实，群聊视口为空', async () => {
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
    assert.equal(bySubject.get('主人')?.some((item) => item.includes('猫')), false, '被覆盖的旧值不应出现')
    assert.ok(bySubject.get('工作')?.includes('在腾讯'))

    assert.deepEqual(await ctx.memory.profile({ audience: 'group:g1' }), [])
  } finally {
    await dispose()
  }
})

test('联想召回：共同出现后建立突触，单关键词也能带回邻居', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      fact('主人', '养', '狗'),
      fact('狗', '叫', '豆豆'),
    ])
    const first = await ctx.memory.recall({ text: '主人 狗 豆豆' })
    assert.equal(first.facts.length, 2, '两个事实都应被召回')
    await new Promise((resolve) => setTimeout(resolve, 30))

    const second = await ctx.memory.recall({ text: '我养什么' })
    const objects = second.facts.map((item) => item.object)
    assert.ok(objects.includes('狗'), '关键词命中养狗')
    assert.ok(objects.includes('豆豆'), '通过突触扩散带回豆豆')
  } finally {
    await dispose()
  }
})

test('召回打分：同相似度时显著度高的排前面', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      { ...fact('主人', '喜欢', '咖啡'), salience: 0.9 },
      { ...fact('同事', '喜欢', '咖啡'), salience: 0.1 },
    ])
    const hit = await ctx.memory.recall({ text: '咖啡' })
    assert.equal(hit.facts[0]?.subject, '主人', '显著度高的应先召回')
  } finally {
    await dispose()
  }
})

test('多跳扩散：两跳外的邻居也能被带回', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([
      fact('主人', '养', '狗'),
      fact('狗', '叫', '豆豆'),
      fact('豆豆', '玩', '玩具'),
    ])
    await ctx.memory.recall({ text: '主人 狗 豆豆' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await ctx.memory.recall({ text: '狗 豆豆 玩具' })
    await new Promise((resolve) => setTimeout(resolve, 30))

    const hit = await ctx.memory.recall({ text: '我养什么', limit: 10 })
    const objects = hit.facts.map((item) => item.object)
    assert.ok(objects.includes('狗'), '一跳：关键词命中')
    assert.ok(objects.includes('豆豆'), '两跳：狗 → 豆豆')
    assert.ok(objects.includes('玩具'), '三跳：豆豆 → 玩具')
  } finally {
    await dispose()
  }
})

test('剪枝：弱且长期未共同激活的突触被删除，强突触保留', async () => {
  const { ctx, dispose } = await setup()
  try {
    await ctx.memory.ingest([fact('主人', '养', '狗'), fact('狗', '叫', '豆豆')])
    const store = (ctx as unknown as { reflect: { get(name: string, required: false): unknown } }).reflect.get('store', false) as {
      collection(name: string): {
        insert(value: Record<string, unknown>): Promise<unknown>
        get(id: string): Promise<unknown>
      }
    }
    const synapses = store.collection('qm_mem_synapse')
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000
    await synapses.insert({ id: 'weak', from_id: 'a', to_id: 'b', kind: 'associative', weight: 0.01, co_activated: 1, last_fired_at: old })
    await synapses.insert({ id: 'strong', from_id: 'c', to_id: 'd', kind: 'associative', weight: 0.8, co_activated: 1, last_fired_at: old })

    const memory = ctx.memory as unknown as { prune(now?: number): Promise<number> }
    const removed = await memory.prune()
    assert.equal(removed, 1)
    assert.equal(await synapses.get('weak'), null)
    assert.ok(await synapses.get('strong'))
  } finally {
    await dispose()
  }
})
