import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from 'cordis'
import { OpenAiLlm, validateConfig } from '../src/index.ts'

interface MockState {
  lastBody: Record<string, unknown> | null
  lastAuth: string | undefined
}

async function withMock(
  handler: (req: IncomingMessage, res: ServerResponse, state: MockState) => void,
  run: (baseURL: string, state: MockState) => Promise<void>,
): Promise<void> {
  const state: MockState = { lastBody: null, lastAuth: undefined }
  const server = createServer((req, res) => handler(req, res, state))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  try {
    await run(`http://127.0.0.1:${address.port}/v1`, state)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
  })
}

/** Service 必须在插件 fiber 内构造，直接 new 会因为没有 provider 上下文而抛错。 */
async function makeLlm(baseURL: string): Promise<OpenAiLlm> {
  const ctx = new Context()
  await ctx.plugin(OpenAiLlm, { baseURL, apiKey: 'test-key', model: 'deepseek-v4-flash' })
  return ctx.llm as OpenAiLlm
}

test('complete：解析非流式响应并带上鉴权与模型', async () => {
  await withMock(
    async (req, res, state) => {
      state.lastBody = await readBody(req)
      state.lastAuth = req.headers.authorization
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '你好，我是青梅' } }] }))
    },
    async (baseURL, state) => {
      const llm = await makeLlm(baseURL)
      const result = await llm.complete({ messages: [{ role: 'user', content: '你是谁' }] })
      assert.equal(result.text, '你好，我是青梅')
      assert.equal(state.lastAuth, 'Bearer test-key')
      assert.equal(state.lastBody?.model, 'deepseek-v4-flash')
      assert.equal(state.lastBody?.stream, false)
      assert.deepEqual(state.lastBody?.messages, [{ role: 'user', content: '你是谁' }])
    },
  )
})

test('chat：解析 SSE 增量并按序拼接', async () => {
  await withMock(
    async (req, res, state) => {
      state.lastBody = await readBody(req)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const piece of ['你好', '，我是', '青梅']) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    },
    async (baseURL, state) => {
      const llm = await makeLlm(baseURL)
      let text = ''
      for await (const chunk of llm.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
        if (chunk.type === 'text') text += chunk.text
      }
      assert.equal(text, '你好，我是青梅')
      assert.equal(state.lastBody?.stream, true)
    },
  )
})

test('chat：上游 HTTP 错误直接抛出，不静默', async () => {
  await withMock(
    (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'upstream down' } }))
    },
    async (baseURL) => {
      const llm = await makeLlm(baseURL)
      const consume = async (): Promise<void> => {
        for await (const _chunk of llm.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
          // 不应有 chunk
        }
      }
      await assert.rejects(consume, /HTTP 500/)
    },
  )
})

test('validateConfig：必需字段缺失时给出明确错误', () => {
  assert.throws(() => validateConfig({ baseURL: '', apiKey: 'k', model: 'm' }), /baseURL/)
  assert.throws(() => validateConfig({ baseURL: 'http://x', apiKey: '', model: 'm' }), /apiKey/)
  assert.throws(() => validateConfig({ baseURL: 'http://x', apiKey: 'k', model: '' }), /model/)
})

test('baseURL 末尾斜杠被规范化', async () => {
  const ctx = new Context()
  await ctx.plugin(OpenAiLlm, {
    baseURL: 'http://127.0.0.1:8081/v1///',
    apiKey: 'k',
    model: 'm',
  })
  assert.equal((ctx.llm as OpenAiLlm).baseURL, 'http://127.0.0.1:8081/v1')
})
