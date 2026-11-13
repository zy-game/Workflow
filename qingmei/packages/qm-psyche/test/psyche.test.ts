import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as psychePlugin from '../src/index.ts'

async function boot(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-psyche-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'psyche.db') })
  await storeFiber
  const gatewayFiber = ctx.plugin(gatewayPlugin)
  await gatewayFiber
  const psycheFiber = ctx.plugin(psychePlugin, { moodHalfLifeHours: 6, ...config })
  await psycheFiber
  const psyche = ctx.get('psyche') as {
    mood(now?: Date): Promise<{ valence: number; label: string }>
    touchMood(delta: Record<string, unknown>, now?: Date): Promise<{ valence: number; label: string }>
    relation(): Promise<{ trust: number; stage: string; sharedEvents: unknown[] }>
    onUserMessage(text: string, now?: Date): Promise<void>
    writeJournal(text: string, day?: string): Promise<{ day: string; text: string }>
    journal(day?: string): Promise<{ text: string } | null>
    context(): Promise<string>
  }
  return {
    ctx,
    psyche,
    async dispose() {
      await psycheFiber.dispose()
      await gatewayFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('心情：事件改变，按半衰期回落', async () => {
  const h = await boot()
  try {
    const t0 = new Date('2026-11-13T10:00:00Z')
    assert.equal((await h.psyche.mood(t0)).label, '平静')
    await h.psyche.touchMood({ valence: 0.8, arousal: 0.7, reason: '被夸' }, t0)
    const happy = await h.psyche.mood(t0)
    assert.equal(happy.label, '兴奋')
    const later = new Date(t0.getTime() + 6 * 3_600_000)
    const decayed = await h.psyche.mood(later)
    assert.ok(Math.abs(decayed.valence - 0.4) < 0.02, '6 小时后愉悦度应减半')
  } finally {
    await h.dispose()
  }
})

test('关系：互动累积信任，足够高时升级；任务完成记共同经历', async () => {
  const h = await boot({ familiarAt: 2, trustedAt: 4 })
  try {
    const t0 = new Date('2026-11-13T10:00:00Z')
    await h.psyche.onUserMessage('谢谢你', t0)
    assert.equal((await h.psyche.relation()).stage, 'new')
    await h.psyche.onUserMessage('今天不错', t0)
    assert.equal((await h.psyche.relation()).stage, 'familiar')
    await h.psyche.onTaskFinished({ status: 'done', title: '修好登录' } as never, t0)
    const relation = await h.psyche.relation()
    assert.ok(relation.trust >= 4)
    assert.equal(relation.stage, 'trusted')
    assert.ok(relation.sharedEvents.some((event) => String(event).includes('修好登录') || JSON.stringify(event).includes('修好登录')))
  } finally {
    await h.dispose()
  }
})

test('日记：按天写入、读取，并进入状态摘要', async () => {
  const h = await boot()
  try {
    await h.psyche.writeJournal('今天把任务合并收口了，有点累但踏实。', '2026-11-13')
    const journal = await h.psyche.journal('2026-11-13')
    assert.match(journal?.text ?? '', /任务合并/)
    const context = await h.psyche.context()
    assert.match(context, /【心情】/)
    assert.match(context, /【关系】/)
    assert.match(context, /【表达】/)
  } finally {
    await h.dispose()
  }
})

