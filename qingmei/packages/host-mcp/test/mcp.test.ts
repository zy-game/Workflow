import test from 'node:test'
import assert from 'node:assert/strict'
import { scheduleInputFrom } from '../src/index.ts'

test('schedule_create：cron + timezone 走周期路径', () => {
  const input = scheduleInputFrom('每天九点提醒我吃药', { cron: '0 9 * * *', timezone: 'Asia/Shanghai' })
  assert.deepEqual(input, { text: '每天九点提醒我吃药', cron: '0 9 * * *', timezone: 'Asia/Shanghai' })
  assert.equal(input.at, undefined)
  assert.equal(input.everyMs, undefined)
})

test('schedule_create：cron 优先于 at 与 seconds', () => {
  const input = scheduleInputFrom('工作日八点半', {
    cron: '30 8 * * 1-5',
    at: '2026-01-01T00:00:00.000Z',
    seconds: 30,
    missedPolicy: 'skip',
  })
  assert.equal(input.cron, '30 8 * * 1-5')
  assert.equal(input.missedPolicy, 'skip')
  assert.equal(input.at, undefined)
  assert.equal(input.everyMs, undefined)
})

test('schedule_create：at 走一次性绝对时间', () => {
  const input = scheduleInputFrom('明早提醒我', { at: '2026-03-02T01:00:00.000Z' })
  assert.equal(input.at?.toISOString(), '2026-03-02T01:00:00.000Z')
  assert.equal(input.everyMs, undefined)
})

test('schedule_create：只给 seconds 时换算成一次性时间，不会无限重复', () => {
  const before = Date.now()
  const input = scheduleInputFrom('五分钟后提醒我', { seconds: 300 })
  const after = Date.now()
  assert.equal(input.everyMs, undefined)
  const at = input.at?.getTime() ?? 0
  assert.ok(at >= before + 300_000 && at <= after + 300_000)
})

test('schedule_create：seconds 非法时退回默认 60 秒', () => {
  const before = Date.now()
  const input = scheduleInputFrom('一会儿提醒我', { seconds: 'abc' })
  const at = input.at?.getTime() ?? 0
  assert.ok(at >= before + 60_000)
})
