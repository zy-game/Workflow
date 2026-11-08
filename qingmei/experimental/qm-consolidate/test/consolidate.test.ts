import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as memoryPlugin from '@qingmei/provider-memory-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as consolidatePlugin from '../src/index.ts'
import {
  ChannelService,
  type GatewayRequest,
  type GatewayResponse,
  type MemoryRecord,
  type MemoryService,
  type OutboundEnvelope,
  type SendResult,
} from '@qingmei/core'

class FakeChannel extends ChannelService {
  readonly sent: OutboundEnvelope[] = []

  async register(): Promise<() => void> {
    return () => undefined
  }

  async send(envelope: OutboundEnvelope): Promise<SendResult> {
    this.sent.push(envelope)
    return { ok: true, platformMessageId: `out_${this.sent.length}` }
  }

  status() {
    return [{ id: 'web' as const, online: true }]
  }
}

function fact(subject: string, predicate: string, object: string, confidence = 0.6): MemoryRecord {
  return {
    kind: 'fact',
    subject,
    predicate,
    object,
    confidence,
    salience: 0.5,
    sensitivity: 'private',
    origin: { kind: 'manual', id: 'test' },
  }
}

interface FakeResponse {
  res: GatewayResponse
  read(): { status: number; body: unknown }
}

function fakeResponse(): FakeResponse {
  let status = 0
  let body: unknown
  const res: GatewayResponse = {
    status(code) {
      status = code
      return res
    },
    header() {
      return res
    },
    send(value) {
      body = value
      return res
    },
  }
  return { res, read: () => ({ status, body }) }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-consolidate-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'consolidate.db') })
  await storeFiber
  const memoryFiber = ctx.plugin(memoryPlugin)
  await memoryFiber
  await ctx.plugin(gatewayPlugin)
  const channel = new FakeChannel(ctx)
  const pluginFiber = ctx.plugin(consolidatePlugin, { hour: 4 })
  await pluginFiber
  const memory = ctx.reflect.get('memory', false) as MemoryService

  return {
    ctx,
    memory,
    channel,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await pluginFiber.dispose()
      await memoryFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(consolidatePlugin.name, 'qm-consolidate')
  assert.deepEqual(consolidatePlugin.inject, ['memory', 'channel', 'gateway', 'store'])
})

test('POST /api/v1/memory/consolidate：压缩同主题低价值事实并报告', async () => {
  const h = await setup()
  try {
    await h.memory.ingest(Array.from({ length: 8 }, (_, index) => fact('主人', `偏好${index}`, `值${index}`, 0.6)))

    const response = await h.call({ method: 'POST', path: '/api/v1/memory/consolidate', query: {}, headers: {} })
    assert.equal(response.status, 200)
    const body = response.body as { ok: boolean; scanned: number; compressed: number }
    assert.equal(body.ok, true)
    assert.equal(body.scanned, 8)
    assert.equal(body.compressed, 3, '每个 subject 保留 5 条，其余低价值压缩')

    assert.equal(h.channel.sent.length, 1)
    assert.match((h.channel.sent[0]!.blocks[0] as { text: string }).text, /记忆巩固/)

    const second = await h.call({ method: 'POST', path: '/api/v1/memory/consolidate', query: {}, headers: {} })
    assert.equal((second.body as { compressed: number }).compressed, 0, '第二次没有可压缩的')
    assert.equal(h.channel.sent.length, 1, '没有压缩就不打扰')
  } finally {
    await h.dispose()
  }
})
