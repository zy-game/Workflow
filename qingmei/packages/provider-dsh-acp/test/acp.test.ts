import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { AcpClient } from '../src/acp-client.ts'
import { DshHarness } from '../src/index.ts'

const FAKE = fileURLToPath(new URL('../fixtures/fake-agent.mjs', import.meta.url))

test('AcpClient：握手、建会话、流式更新与结束原因', async () => {
  const updates: { sessionId: string; update: Record<string, unknown> }[] = []
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
    onUpdate: (update) => updates.push(update),
  })
  try {
    await client.start()
    const sessionId = await client.newSession(process.cwd())
    assert.equal(sessionId, 'sess-1')

    const result = await client.prompt(sessionId, 'hi')
    assert.equal(result.stopReason, 'end_turn')

    const texts = updates
      .filter((u) => u.update.sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.update.content as { text?: string })?.text ?? '')
    assert.equal(texts.join(''), '你好')
    assert.ok(updates.some((u) => u.update.sessionUpdate === 'tool_call'))
  } finally {
    client.stop()
  }
})

test('DshHarness：run 产出 text/tool/done 事件，并在重复调用时复用会话', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(DshHarness, {
    command: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
  })
  await fiber
  try {
    assert.equal(await ctx.harness.available(), true)

    const first: string[] = []
    const kinds: string[] = []
    for await (const event of ctx.harness.run({ conversationId: 'c1', text: '第一轮' })) {
      kinds.push(event.type)
      if (event.type === 'text') first.push(event.text)
    }
    assert.equal(first.join(''), '你好')
    assert.equal(kinds.at(-1), 'done')
    assert.ok(kinds.includes('tool'))

    // 第二轮应复用同一个 ACP 会话（fake agent 固定返回 sess-1，不会新建）
    const second: string[] = []
    for await (const event of ctx.harness.run({ conversationId: 'c1', text: '第二轮' })) {
      if (event.type === 'text') second.push(event.text)
    }
    assert.equal(second.join(''), '你好')
  } finally {
    await fiber.dispose()
  }
})

test('DshHarness：子进程起不来时 available=false，并回报 error', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(DshHarness, {
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    cwd: process.cwd(),
    timeoutMs: 3000,
  })
  await fiber
  try {
    // 子进程立即退出：initialize 失败，available 必须为 false
    assert.equal(await ctx.harness.available(), false)
  } finally {
    await fiber.dispose()
  }
})
