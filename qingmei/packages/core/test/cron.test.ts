import test from 'node:test'
import assert from 'node:assert/strict'
import { nextCronTime, parseCron } from '../src/index.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function iso(value: Date): string {
  return value.toISOString()
}

test('*/15 * * * *：连续五次 nextAt 间隔 15 分钟', () => {
  let cursor = new Date('2026-01-01T00:00:00.000Z')
  const times: Date[] = []
  for (let i = 0; i < 5; i++) {
    cursor = nextCronTime('*/15 * * * *', cursor, 'UTC')
    times.push(cursor)
  }
  assert.deepEqual(times.map(iso), [
    '2026-01-01T00:15:00.000Z',
    '2026-01-01T00:30:00.000Z',
    '2026-01-01T00:45:00.000Z',
    '2026-01-01T01:00:00.000Z',
    '2026-01-01T01:15:00.000Z',
  ])
  for (let i = 1; i < times.length; i++) {
    assert.equal(times[i]!.getTime() - times[i - 1]!.getTime(), 15 * MINUTE)
  }
})

test('0 9 * * 1-5：跨周末跳到周一', () => {
  const friday = new Date('2026-03-06T10:00:00.000Z')
  const monday = nextCronTime('0 9 * * 1-5', friday, 'UTC')
  assert.equal(iso(monday), '2026-03-09T09:00:00.000Z')
  assert.equal(monday.getUTCDay(), 1)
})

test('0 0 31 * *：没有 31 号的月份跳过', () => {
  const first = nextCronTime('0 0 31 * *', new Date('2026-01-01T00:00:00.000Z'), 'UTC')
  assert.equal(iso(first), '2026-01-31T00:00:00.000Z')
  const second = nextCronTime('0 0 31 * *', first, 'UTC')
  assert.equal(iso(second), '2026-03-31T00:00:00.000Z')
  const third = nextCronTime('0 0 31 * *', second, 'UTC')
  assert.equal(iso(third), '2026-05-31T00:00:00.000Z')
})

test('0 0 29 2 *：闰日只在闰年触发', () => {
  const leap = nextCronTime('0 0 29 2 *', new Date('2025-01-01T00:00:00.000Z'), 'UTC')
  assert.equal(iso(leap), '2028-02-29T00:00:00.000Z')
  assert.equal(iso(nextCronTime('0 0 29 2 *', leap, 'UTC')), '2032-02-29T00:00:00.000Z')
})

test('Europe/Berlin 春令时：09:00 不重复、不漏', () => {
  let cursor = new Date('2026-03-27T12:00:00.000Z')
  const times: Date[] = []
  for (let i = 0; i < 4; i++) {
    cursor = nextCronTime('0 9 * * *', cursor, 'Europe/Berlin')
    times.push(cursor)
  }
  assert.deepEqual(times.map(iso), [
    '2026-03-28T08:00:00.000Z',
    '2026-03-29T07:00:00.000Z',
    '2026-03-30T07:00:00.000Z',
    '2026-03-31T07:00:00.000Z',
  ])
  // 3/29 凌晨拨快一小时，当天只有 23 小时
  assert.equal(times[1]!.getTime() - times[0]!.getTime(), 23 * HOUR)
  assert.equal(times[2]!.getTime() - times[1]!.getTime(), 24 * HOUR)
})

test('Europe/Berlin 冬令时：09:00 一天只触发一次', () => {
  let cursor = new Date('2026-10-23T12:00:00.000Z')
  const times: Date[] = []
  for (let i = 0; i < 4; i++) {
    cursor = nextCronTime('0 9 * * *', cursor, 'Europe/Berlin')
    times.push(cursor)
  }
  assert.deepEqual(times.map(iso), [
    '2026-10-24T07:00:00.000Z',
    '2026-10-25T08:00:00.000Z',
    '2026-10-26T08:00:00.000Z',
    '2026-10-27T08:00:00.000Z',
  ])
  // 10/25 凌晨拨慢一小时，当天有 25 小时
  assert.equal(times[1]!.getTime() - times[0]!.getTime(), 25 * HOUR)
  assert.equal(times[2]!.getTime() - times[1]!.getTime(), 24 * HOUR)
})

test('Europe/Berlin 02:30：跳过的本地时间不触发，重复的本地时间只触发一次', () => {
  // 3/29 的 02:30 不存在，跳到 3/30（CEST）
  const spring = nextCronTime('30 2 * * *', new Date('2026-03-28T12:00:00.000Z'), 'Europe/Berlin')
  assert.equal(iso(spring), '2026-03-30T00:30:00.000Z')

  // 10/25 的 02:30 出现两次，取较早的那次（CEST）
  const fall = nextCronTime('30 2 * * *', new Date('2026-10-24T12:00:00.000Z'), 'Europe/Berlin')
  assert.equal(iso(fall), '2026-10-25T00:30:00.000Z')
  // 同一天的第二遍 02:30（CET）不再补一次
  assert.equal(iso(nextCronTime('30 2 * * *', fall, 'Europe/Berlin')), '2026-10-26T01:30:00.000Z')
})

test('跨时区：同一 cron 在 UTC 与 Asia/Shanghai 相差 8 小时', () => {
  const after = new Date('2026-06-01T00:00:00.000Z')
  const utc = nextCronTime('0 9 * * *', after, 'UTC')
  const shanghai = nextCronTime('0 9 * * *', after, 'Asia/Shanghai')
  assert.equal(iso(utc), '2026-06-01T09:00:00.000Z')
  assert.equal(iso(shanghai), '2026-06-01T01:00:00.000Z')
  assert.equal(utc.getTime() - shanghai.getTime(), 8 * HOUR)
})

test('周字段：0 与 7 都是周日', () => {
  const thursday = new Date('2026-03-05T00:00:00.000Z')
  assert.equal(iso(nextCronTime('0 0 * * 7', thursday, 'UTC')), '2026-03-08T00:00:00.000Z')
  assert.equal(iso(nextCronTime('0 0 * * 0', thursday, 'UTC')), '2026-03-08T00:00:00.000Z')
})

test('日与周同时限定时取「或」', () => {
  // 2026-03-24 周二：下一个周一 3/30 早于下一个 1 号 4/1
  const nearMonday = nextCronTime('0 0 1 * 1', new Date('2026-03-24T00:00:00.000Z'), 'UTC')
  assert.equal(iso(nearMonday), '2026-03-30T00:00:00.000Z')
  // 2026-04-02 周四：下一个 1 号 5/1 晚于下一个周一 4/6
  const nearFirst = nextCronTime('0 0 1 * 1', new Date('2026-04-02T00:00:00.000Z'), 'UTC')
  assert.equal(iso(nearFirst), '2026-04-06T00:00:00.000Z')
})

test('非法表达式直接报错，不静默', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  assert.throws(() => nextCronTime('0 9 * *', now, 'UTC'), /5 段/)
  assert.throws(() => nextCronTime('60 9 * * *', now, 'UTC'), /分字段越界/)
  assert.throws(() => nextCronTime('0 24 * * *', now, 'UTC'), /时字段越界/)
  assert.throws(() => nextCronTime('0 9 32 * *', now, 'UTC'), /日字段越界/)
  assert.throws(() => nextCronTime('0 9 * 13 *', now, 'UTC'), /月字段越界/)
  assert.throws(() => nextCronTime('0 9 * * 8', now, 'UTC'), /周字段越界/)
  assert.throws(() => nextCronTime('0 9 1- * *', now, 'UTC'), /范围写法非法/)
  assert.throws(() => nextCronTime('0 9 5-1 * *', now, 'UTC'), /起点大于终点/)
  assert.throws(() => nextCronTime('0 9 * * abc', now, 'UTC'), /不是整数/)
  assert.throws(() => nextCronTime('0 9 * * */0', now, 'UTC'), /步长/)
  assert.throws(() => nextCronTime('0 9 * * *', now, 'Mars/Olympus'), /无效的时区/)
})

test('parseCron：逗号列表与区间步长合并去重', () => {
  const spec = parseCron('0,30-40/5 9 * * *')
  assert.deepEqual(spec.minute, [0, 30, 35, 40])
  assert.deepEqual(spec.hour, [9])
  assert.equal(spec.dayOfMonthRestricted, false)
  assert.equal(spec.dayOfWeekRestricted, false)
})
