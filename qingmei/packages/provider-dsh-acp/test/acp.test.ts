import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { AcpClient, type AcpPermissionRequest } from '../src/acp-client.ts'
import {
  ApprovalService,
  type ApprovalRequest,
  type CreateApprovalInput,
} from '@qingmei/core'
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
    assert.ok(kinds.includes('usage'), 'harness 应把 ACP 的 usage 转成事件')

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

test('AcpClient：把 session/request_permission 交给回调，并按 optionId 回 selected', async () => {
  const seen: AcpPermissionRequest[] = []
  const updates: string[] = []
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
    env: { FAKE_MODE: 'permission' },
    onPermissionRequest: async (request) => {
      seen.push(request)
      return 'allow-1'
    },
    onUpdate: (update) => {
      const content = update.update.content as { text?: string } | undefined
      if (typeof content?.text === 'string') updates.push(content.text)
    },
  })
  try {
    await client.start()
    const sessionId = await client.newSession(process.cwd())
    const result = await client.prompt(sessionId, '跑测试')

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.sessionId, sessionId)
    assert.equal(seen[0]!.toolCall?.title, 'bash: npm test')
    assert.deepEqual(
      seen[0]!.options?.map((option) => option.kind),
      ['allow_once', 'reject_once'],
    )
    assert.equal(updates.join(''), 'perm:selected:allow-1')
  } finally {
    client.stop()
  }
})

test('AcpClient：回调返回 null 时回 cancelled，子 agent 不会卡住', async () => {
  const updates: string[] = []
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
    env: { FAKE_MODE: 'permission' },
    onPermissionRequest: async () => null,
    onUpdate: (update) => {
      const content = update.update.content as { text?: string } | undefined
      if (typeof content?.text === 'string') updates.push(content.text)
    },
  })
  try {
    await client.start()
    const sessionId = await client.newSession(process.cwd())
    const result = await client.prompt(sessionId, '跑测试')
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(updates.join(''), 'perm:cancelled')
  } finally {
    client.stop()
  }
})

test('DshHarness：权限请求走审批队列，批准后继续', async () => {
  const ctx = new Context()
  const approvals = new FakeApproval(ctx, 'allowed')
  const fiber = ctx.plugin(DshHarness, {
    command: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
    env: { FAKE_MODE: 'permission' },
    approvalTimeoutMs: 2000,
  })
  await fiber
  try {
    const texts: string[] = []
    for await (const event of ctx.harness.run({ conversationId: 'c1', text: '跑测试' })) {
      if (event.type === 'text') texts.push(event.text)
    }
    assert.equal(texts.join(''), 'perm:selected:allow-1')
    assert.equal(approvals.created.length, 1)
    assert.equal(approvals.created[0]!.action, 'acp:bash: npm test')
    assert.equal(approvals.created[0]!.requester, 'harness:dsh')
  } finally {
    await fiber.dispose()
  }
})

test('DshHarness：审批被拒绝时选 reject 选项', async () => {
  const ctx = new Context()
  new FakeApproval(ctx, 'denied')
  const fiber = ctx.plugin(DshHarness, {
    command: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
    env: { FAKE_MODE: 'permission' },
    approvalTimeoutMs: 2000,
  })
  await fiber
  try {
    const texts: string[] = []
    for await (const event of ctx.harness.run({ conversationId: 'c1', text: '跑测试' })) {
      if (event.type === 'text') texts.push(event.text)
    }
    assert.equal(texts.join(''), 'perm:selected:reject-1')
  } finally {
    await fiber.dispose()
  }
})

test('DshHarness：没有审批服务时一律取消（不静默放行）', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(DshHarness, {
    command: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
    env: { FAKE_MODE: 'permission' },
    approvalTimeoutMs: 2000,
  })
  await fiber
  try {
    const texts: string[] = []
    for await (const event of ctx.harness.run({ conversationId: 'c1', text: '跑测试' })) {
      if (event.type === 'text') texts.push(event.text)
    }
    assert.equal(texts.join(''), 'perm:cancelled')
  } finally {
    await fiber.dispose()
  }
})

/** 只实现 DshHarness 用到的两个方法的审批替身 */
class FakeApproval extends ApprovalService {
  readonly created: ApprovalRequest[] = []
  private readonly outcome: 'allowed' | 'denied'
  private readonly ctx: Context

  constructor(ctx: Context, outcome: 'allowed' | 'denied') {
    super(ctx)
    this.ctx = ctx
    this.outcome = outcome
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: `ap_${this.created.length + 1}`,
      action: input.action,
      prompt: input.prompt,
      status: 'pending',
      runId: input.runId ?? null,
      requester: input.requester ?? 'unknown',
      channel: 'web',
      createdAt: new Date(),
      decidedAt: null,
      reason: null,
    }
    this.created.push(request)
    this.ctx.events.emit('qm/approval/requested', request)
    return request
  }

  async get(): Promise<ApprovalRequest | null> {
    return null
  }

  async list(): Promise<ApprovalRequest[]> {
    return [...this.created]
  }

  async decide(): Promise<ApprovalRequest | null> {
    return null
  }

  async wait(): Promise<ApprovalRequest | null> {
    const base = this.created.at(-1)
    if (!base) return null
    return { ...base, status: this.outcome, decidedAt: new Date() }
  }
}

test('AcpClient：实现 fs/*，子 agent 能在会话目录里写读文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-fs-'))
  const texts: string[] = []
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
    env: { FAKE_MODE: 'fs' },
    onUpdate: (update) => {
      const content = update.update.content as { text?: string } | undefined
      if (typeof content?.text === 'string') texts.push(content.text)
    },
  })
  try {
    await client.start()
    const sessionId = await client.newSession(dir)
    await client.prompt(sessionId, '写个文件')
    assert.equal(texts.join(''), 'fs:你好，青梅')
    assert.equal(readFileSync(join(dir, 'notes/hello.txt'), 'utf8'), '你好，青梅')
  } finally {
    client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AcpClient：fs/* 拒绝会话目录外的路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-escape-'))
  const texts: string[] = []
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
    env: { FAKE_MODE: 'escape' },
    onUpdate: (update) => {
      const content = update.update.content as { text?: string } | undefined
      if (typeof content?.text === 'string') texts.push(content.text)
    },
  })
  try {
    await client.start()
    const sessionId = await client.newSession(dir)
    await client.prompt(sessionId, '读点目录外的文件')
    assert.match(texts.join(''), /^fs-error:.*路径越界/)
  } finally {
    client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AcpClient：实现 terminal/*，能跑命令并读到输出与退出码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-term-'))
  const texts: string[] = []
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
    env: { FAKE_MODE: 'terminal' },
    onUpdate: (update) => {
      const content = update.update.content as { text?: string } | undefined
      if (typeof content?.text === 'string') texts.push(content.text)
    },
  })
  try {
    await client.start()
    const sessionId = await client.newSession(dir)
    await client.prompt(sessionId, '跑个命令')
    assert.equal(texts.join(''), 'term:0:term-ok')
  } finally {
    client.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AcpClient：initialize 声明 fs 与 terminal 能力', async () => {
  const texts: string[] = []
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE],
    cwd: process.cwd(),
    env: { FAKE_MODE: 'caps' },
    onUpdate: (update) => {
      const content = update.update.content as { text?: string } | undefined
      if (typeof content?.text === 'string') texts.push(content.text)
    },
  })
  try {
    await client.start()
    const sessionId = await client.newSession(process.cwd())
    await client.prompt(sessionId, '看能力')
    assert.equal(texts.join(''), 'caps:ok', '不声明 clientCapabilities 的话，agent 不会给文件/终端工具')
  } finally {
    client.stop()
  }
})
