import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as schedulePlugin from '../src/index.ts'
import { EVENTS, nextCronTime, type Scheduled, type StoreService } from '@qingmei/core'

interface ScheduleRow {
  id: string
  next_at: number
  cron?: string | null
  fired_at: number | null
  [key: string]: unknown
}

const DAY = 24 * 60 * 60 * 1000

async function setup(config: { defaultTimezone?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-schedule-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'schedule.db') })
  await storeFiber
  // 计时器拉到一分钟：测试自己调 tick()，不靠真实时间推进
  const scheduleFiber = ctx.plugin(schedulePlugin, { tickMs: 60_000, ...config })
  await scheduleFiber
  const fired: Scheduled[] = []
  ctx.events.on(EVENTS.scheduleDue, (item: Scheduled) => {
    fired.push(item)
  })
  const store = ctx.reflect.get('store', false) as StoreService
  const rows = store.collection<ScheduleRow>('qm_schedule')
  return {
    schedule: ctx.schedule,
    fired,
    rows,
    async dispose() {
      await scheduleFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('create：cron 落库并算出下一次触发', async () => {
  const { schedule, dispose } = await setup()
  try {
    const item = await schedule.create({ text: '喝水', cron: '0 9 * * *', timezone: 'Asia/Shanghai' })
    assert.equal(item.cron, '0 9 * * *')
    assert.equal(item.timezone, 'Asia/Shanghai')
    assert.equal(item.everyMs, null)
    assert.equal(item.missedPolicy, 'fire-once')
    assert.equal(item.firedAt, null)
    // 下一次触发必须是该 cron 的一次真实命中的前一毫秒的下一跳
    const again = nextCronTime('0 9 * * *', new Date(item.nextAt.getTime() - 1), 'Asia/Shanghai')
    assert.equal(again.getTime(), item.nextAt.getTime())
  } finally {
    await dispose()
  }
})

test('create：cron 不带时区时用配置的默认时区', async () => {
  const { schedule, dispose } = await setup({ defaultTimezone: 'Asia/Shanghai' })
  try {
    const item = await schedule.create({ text: '喝水', cron: '0 9 * * *' })
    assert.equal(item.timezone, 'Asia/Shanghai')
    assert.equal(item.nextAt.getUTCHours(), 1)
    assert.equal(item.nextAt.getUTCMinutes(), 0)
  } finally {
    await dispose()
  }
})

test('create：非法 cron 直接报错，不落库', async () => {
  const { schedule, dispose } = await setup()
  try {
    await assert.rejects(schedule.create({ text: '坏规则', cron: '0 9 * *' }), /5 段/)
    await assert.rejects(schedule.create({ text: '坏时区', cron: '0 9 * * *', timezone: 'Mars/Olympus' }), /无效的时区/)
    assert.equal((await schedule.list()).length, 0)
  } finally {
    await dispose()
  }
})

test('tick：cron 到点触发一次并重排到下一次', async () => {
  const { schedule, fired, rows, dispose } = await setup()
  try {
    const item = await schedule.create({ text: '上班', cron: '0 9 * * *', timezone: 'UTC' })
    await rows.update(item.id, { next_at: Date.now() - 60_000 })

    await schedule.tick()
    assert.equal(fired.length, 1)
    assert.equal(fired[0]?.id, item.id)

    const [after] = await schedule.list()
    assert.ok(after)
    assert.ok(after.nextAt.getTime() > Date.now())
    // cron 行不写 fired_at，否则会从「待触发」列表里消失
    assert.equal(after.firedAt, null)
  } finally {
    await dispose()
  }
})

test('tick：停机错过多次时默认只补发一次', async () => {
  const { schedule, fired, rows, dispose } = await setup()
  try {
    const item = await schedule.create({ text: '吃药', cron: '0 9 * * *', timezone: 'UTC' })
    await rows.update(item.id, { next_at: Date.now() - 3 * DAY })

    await schedule.tick()
    assert.equal(fired.length, 1)
    await schedule.tick()
    assert.equal(fired.length, 1)

    const [after] = await schedule.list()
    assert.ok(after)
    assert.ok(after.nextAt.getTime() > Date.now())
  } finally {
    await dispose()
  }
})

test('tick：missedPolicy=skip 时错过整周期的不补发', async () => {
  const { schedule, fired, rows, dispose } = await setup()
  try {
    const item = await schedule.create({
      text: '吃药',
      cron: '0 9 * * *',
      timezone: 'UTC',
      missedPolicy: 'skip',
    })
    assert.equal(item.missedPolicy, 'skip')
    await rows.update(item.id, { next_at: Date.now() - 3 * DAY })

    await schedule.tick()
    assert.equal(fired.length, 0)

    const [after] = await schedule.list()
    assert.ok(after)
    assert.ok(after.nextAt.getTime() > Date.now())
  } finally {
    await dispose()
  }
})

test('tick：一次性提醒只触发一次', async () => {
  const { schedule, fired, dispose } = await setup()
  try {
    await schedule.create({ text: '开会', at: new Date(Date.now() - 1_000) })
    await schedule.tick()
    assert.equal(fired.length, 1)

    await schedule.tick()
    assert.equal(fired.length, 1)
    const [after] = await schedule.list()
    assert.ok(after)
    assert.ok(after.firedAt instanceof Date)
  } finally {
    await dispose()
  }
})

test('tick：固定间隔按「现在」重排，停机再久也只补一次', async () => {
  const { schedule, fired, rows, dispose } = await setup()
  try {
    const item = await schedule.create({ text: '伸展', everyMs: 60_000 })
    await rows.update(item.id, { next_at: Date.now() - 5 * 60_000 })

    await schedule.tick()
    assert.equal(fired.length, 1)

    const [after] = await schedule.list()
    assert.ok(after)
    const gap = after.nextAt.getTime() - Date.now()
    assert.ok(gap > 0 && gap <= 60_000)
  } finally {
    await dispose()
  }
})

test('tick：旧版遗留的固定间隔行（fired_at 有值）保持退休，不会被复活', async () => {
  const { schedule, fired, rows, dispose } = await setup()
  try {
    const item = await schedule.create({ text: '旧行', everyMs: 5_000 })
    // 模拟老代码留下的行：触发过一次并写了 fired_at
    await rows.update(item.id, { next_at: Date.now() - 60_000, fired_at: Date.now() - 60_000 })

    await schedule.tick()
    assert.equal(fired.length, 0)

    const [after] = await schedule.list()
    assert.ok(after)
    assert.ok(after.firedAt instanceof Date)
  } finally {
    await dispose()
  }
})

test('tick：固定间隔的下一轮到点后继续触发', async () => {
  const { schedule, fired, rows, dispose } = await setup()
  try {
    const item = await schedule.create({ text: '伸展', everyMs: 60_000 })
    await rows.update(item.id, { next_at: Date.now() - 1_000 })
    await schedule.tick()
    assert.equal(fired.length, 1)

    const [after] = await schedule.list()
    assert.ok(after)
    assert.equal(after.firedAt, null)
    await rows.update(item.id, { next_at: Date.now() - 1_000 })
    await schedule.tick()
    assert.equal(fired.length, 2)
  } finally {
    await dispose()
  }
})
