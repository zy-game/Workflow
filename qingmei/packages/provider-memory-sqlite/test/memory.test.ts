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
