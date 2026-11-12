/**
 * provider-embedding-http：向量请求 + usage 记账；没配 url 时不注册服务。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as embeddingPlugin from '../src/index.ts'

function boot(options: { url?: string; fetchImpl?: typeof fetch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-embedding-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'embedding.db') })
  return { ctx, dir, storeFiber }
}

test('每次调用把 usage 按天累计', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }], usage: { total_tokens: 19 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  const h = boot()
  await h.storeFiber
  const pluginFiber = h.ctx.plugin(embeddingPlugin, { url: 'https://example.test/embeddings', fetchImpl: fakeFetch })
  await pluginFiber
  try {
    const vectors = await h.ctx.embedding.embed(['a', 'b'])
    assert.equal(vectors.length, 2)
    const store = h.ctx.reflect.get('store', false) as { collection(name: string): any }
    const today = new Date().toISOString().slice(0, 10)
    const first = await store.collection('qm_embedding_usage').get(today)
    assert.equal(first.tokens, 19)
    assert.equal(first.calls, 1)

    await h.ctx.embedding.embed(['c', 'd'])
    const second = await store.collection('qm_embedding_usage').get(today)
    assert.equal(second.tokens, 38)
    assert.equal(second.calls, 2)
  } finally {
    await pluginFiber.dispose()
    await h.storeFiber.dispose()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('没有 url 时不注册 embedding 服务', async () => {
  const h = boot()
  await h.storeFiber
  const pluginFiber = h.ctx.plugin(embeddingPlugin, {})
  await pluginFiber
  try {
    assert.equal(h.ctx.get('embedding', false), undefined)
  } finally {
    await pluginFiber.dispose()
    await h.storeFiber.dispose()
    rmSync(h.dir, { recursive: true, force: true })
  }
})
