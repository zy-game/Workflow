import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import * as plugin from '../src/index.ts'
import { OpenAiEmbedding } from '../src/index.ts'

test('OpenAI 兼容 embedding：请求格式、排序与返回', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(
      JSON.stringify({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  const ctx = new Context()
  const service = new OpenAiEmbedding(ctx, {
    baseURL: 'https://example.test/v1/',
    apiKey: 'k',
    model: 'm',
    fetchImpl: fakeFetch,
  })
  const vectors = await service.embed(['a', 'b'])
  assert.deepEqual(vectors, [
    [1, 0],
    [0, 1],
  ])
  assert.equal(calls[0]?.url, 'https://example.test/v1/embeddings')
  const body = JSON.parse(String(calls[0]?.init.body)) as { model: string; input: string[] }
  assert.equal(body.model, 'm')
  assert.deepEqual(body.input, ['a', 'b'])
  assert.match(String((calls[0]?.init.headers as Record<string, string>).Authorization), /^Bearer k$/)

  await assert.rejects(() => service.embed(['a']), /条数/)
})

test('插件形态与配置缺失时报错', async () => {
  assert.equal(plugin.name, 'provider-embedding-openai')
  assert.deepEqual(plugin.inject, [])
  const ctx = new Context()
  const service = new OpenAiEmbedding(ctx, { baseURL: '' })
  await assert.rejects(() => service.embed(['x']), /baseURL/)
})
