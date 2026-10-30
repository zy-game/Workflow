/**
 * EchoLlm 的行为测试：回答内容、切片长度、片间停顿、中止与配置校验。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import { LlmService as CoreLlmService } from '@qingmei/core'
import {
  LlmService,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamChunk,
} from '@qingmei/service-llm'

import * as echo from '../src/index.ts'
import { EchoLlm } from '../src/index.ts'

const GREETING = '我是青梅。'

async function boot(greeting = GREETING): Promise<{ ctx: Context; llm: LlmService }> {
  const ctx = new Context()
  await ctx.plugin(echo, { greeting })
  return { ctx, llm: await waitForService<LlmService>(ctx, 'llm') }
}

async function waitForService<T>(ctx: Context, key: string): Promise<T> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const value = ctx.reflect.get(key, false) as T | undefined
    if (value) return value
    await delay(2)
  }
  throw new Error(`等待超时：服务 "${key}" 未注册`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function userMessages(...contents: string[]): ChatMessage[] {
  return contents.map((content) => ({ role: 'user', content }))
}

async function collect(stream: AsyncIterable<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const chunks: ChatStreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function textChunks(chunks: ChatStreamChunk[]): string[] {
  return chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : []))
}

test('service-llm 门面重导出的就是 core 里的那个 LlmService', () => {
  assert.equal(LlmService, CoreLlmService)
})

test('apply 注册名为 llm 的服务，complete 用问候语回答最后一条 user 输入', async () => {
  const { llm } = await boot()
  assert.ok(llm instanceof LlmService)
  assert.ok(llm instanceof EchoLlm)

  const result = await llm.complete({
    messages: [
      { role: 'system', content: '你是青梅。' },
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: '新问题' },
    ],
  })
  assert.deepEqual(result, { text: '我是青梅。\n你说：新问题' })
})

test('没有 user 消息时 complete 直接报错，不编造回答', async () => {
  const { llm } = await boot()
  const request: ChatRequest = {
    messages: [{ role: 'system', content: '你是青梅。' }],
  }
  await assert.rejects(llm.complete(request), /至少一条 user 消息/)
})

test('chat 的片长落在 8~20 字，拼接后等于完整回复', async () => {
  const { llm } = await boot()

  for (const size of [0, 1, 3, 8, 16, 20, 21, 40, 41, 100, 155]) {
    const user = 'x'.repeat(size)
    const chunks = await collect(llm.chat({ messages: userMessages(user) }))
    const pieces = textChunks(chunks)
    const expected = `${GREETING}\n你说：${user}`

    assert.equal(pieces.join(''), expected, `用户输入 ${size} 字时拼接结果不对`)
    assert.equal(chunks.at(-1)?.type, 'done', '最后一片必须是 done')
    assert.equal(chunks.filter((chunk) => chunk.type === 'done').length, 1)

    for (const piece of pieces) {
      assert.ok(piece.length > 0, '不应出现空片')
      assert.ok(piece.length <= 20, `片长 ${piece.length} 超过 20：${piece}`)
      if (expected.length >= 8) {
        assert.ok(piece.length >= 8, `片长 ${piece.length} 小于 8：${piece}`)
      }
    }
  }
})

test('chat 按 20 字上限均分：69 字回答切成 4 片', async () => {
  const { llm } = await boot()
  const chunks = await collect(llm.chat({ messages: userMessages('x'.repeat(60)) }))
  const pieces = textChunks(chunks)

  assert.equal(pieces.length, 4)
  assert.deepEqual(
    pieces.map((piece) => piece.length),
    [18, 17, 17, 17],
  )
})

test('chat 在相邻两片之间等待约 10ms', async () => {
  const { llm } = await boot()
  const user = 'x'.repeat(60) // 69 字 → 4 片 → 3 次停顿
  const started = Date.now()
  const chunks = await collect(llm.chat({ messages: userMessages(user) }))
  const elapsed = Date.now() - started

  assert.equal(textChunks(chunks).length, 4)
  assert.ok(elapsed >= 24, `4 片之间应有 3 次 10ms 停顿，实际仅 ${elapsed}ms`)
})

test('signal 已中止时 chat 一片都不吐', async () => {
  const { llm } = await boot()
  const controller = new AbortController()
  controller.abort()

  const chunks = await collect(
    llm.chat({ messages: userMessages('x'.repeat(60)), signal: controller.signal }),
  )
  assert.deepEqual(chunks, [])
})

test('流式途中中止：不再吐后续片，也不发 done', async () => {
  const { llm } = await boot()
  const controller = new AbortController()
  const iterator = llm
    .chat({ messages: userMessages('x'.repeat(60)), signal: controller.signal })
    [Symbol.asyncIterator]()

  const first = await iterator.next()
  assert.equal(first.done, false)
  assert.equal(first.value?.type, 'text')

  controller.abort()
  const second = await iterator.next()
  assert.equal(second.done, true)
})

test('greeting 缺失或为空时构造即报错', () => {
  const ctx = new Context()
  assert.throws(() => new EchoLlm(ctx, { greeting: '' }), /config\.greeting/)
  assert.throws(
    () => new EchoLlm(ctx, {} as unknown as { greeting: string }),
    /config\.greeting/,
  )
})
