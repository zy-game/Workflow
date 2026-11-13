import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as psychePlugin from '../src/index.ts'

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-psyche-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'psyche.db') })
  await storeFiber
  const gatewayFiber = ctx.plugin(gatewayPlugin)
  await gatewayFiber
  const psycheFiber = ctx.plugin(psychePlugin)
  await psycheFiber
  const psyche = ctx.get('psyche') as {
    relation(): Promise<{ events: Array<{ text: string; kind: string }> }>
    recordEvent(text: string, kind?: 'done' | 'failed', now?: Date): Promise<void>
    onTaskFinished(run: unknown, now?: Date): Promise<void>
    writeJournal(text: string, day?: string): Promise<{ day: string; text: string }>
    journal(day?: string): Promise<{ text: string } | null>
    writeNote(kind: 'plan' | 'review', text: string, day?: string): Promise<{ text: string }>
    note(day: string, kind: 'plan' | 'review'): Promise<{ text: string } | null>
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

test('关系只记事件：完成与失败都进账本，没有 trust/情绪评分', async () => {
  const h = await boot()
  try {
    const t0 = new Date('2026-11-13T10:00:00Z')
    await h.psyche.onTaskFinished({ status: 'done', title: '修好登录' }, t0)
    await h.psyche.onTaskFinished({ status: 'failed', title: '部署失败' }, t0)
    const relation = await h.psyche.relation()
    assert.ok(relation.events.some((event) => event.text.includes('修好登录')))
    assert.ok(relation.events.some((event) => event.text.includes('部署失败') && event.kind === 'failed'))
    assert.equal('trust' in relation, false)
    assert.equal('mood' in relation, false)
  } finally {
    await h.dispose()
  }
})

test('日记与每日笔记：按天写入、读取，并进入上下文', async () => {
  const h = await boot()
  try {
    await h.psyche.writeJournal('今天把任务合并收口了。', '2026-11-13')
    await h.psyche.writeNote('plan', '今天只做三件事。', '2026-11-13')
    assert.match((await h.psyche.journal('2026-11-13'))?.text ?? '', /任务合并/)
    assert.match((await h.psyche.note('2026-11-13', 'plan'))?.text ?? '', /三件事/)
    await h.psyche.recordEvent('一起完成：修好登录')
    const context = await h.psyche.context()
    assert.match(context, /最近一起经历/)
    assert.match(context, /今天的计划/)
    assert.match(context, /今天的日记/)
    assert.ok(!context.includes('心情'))
  } finally {
    await h.dispose()
  }
})
