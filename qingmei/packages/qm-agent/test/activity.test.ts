/**
 * 时间解析与「最近 7 天」活动摘要的单元测试。
 * 这两个函数决定「上周三我让你改了什么」能不能落到正确的时间窗，
 * 以及「最近在忙什么」是否有确定性答案（不依赖模型）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatRecentActivity, parseTimeRange } from '../src/index.ts'
import type { Scheduled, TaskRun } from '@qingmei/core'

const now = new Date(2026, 10, 12, 15, 30) // 2026-11-12 15:30 本地时间

test('parseTimeRange：今天/昨天/前天', () => {
  assert.deepEqual(parseTimeRange('今天做了啥', now), {
    since: new Date(2026, 10, 12),
    until: now,
  })
  const yesterday = parseTimeRange('昨天呢', now)!
  assert.equal(yesterday.since.getDate(), 11)
  assert.equal(yesterday.until.getDate(), 12)
  const before = parseTimeRange('前天', now)!
  assert.equal(before.since.getDate(), 10)
})

test('parseTimeRange：最近 N 天与上周', () => {
  const week = parseTimeRange('最近 7 天', now)!
  assert.equal(Math.round((now.getTime() - week.since.getTime()) / 86_400_000), 7)
  const lastWeek = parseTimeRange('上周的进展', now)!
  assert.equal(lastWeek.since.getDay(), 1, '从周一算')
  assert.ok(lastWeek.until.getTime() > lastWeek.since.getTime())
})

test('parseTimeRange：月份与年份，解析不了返回 null', () => {
  const lastMonth = parseTimeRange('上个月聊过什么', now)!
  assert.equal(lastMonth.since.getMonth(), 9)
  assert.equal(lastMonth.until.getMonth(), 10)
  const lastYear = parseTimeRange('去年的事', now)!
  assert.equal(lastYear.since.getFullYear(), 2025)
  assert.equal(parseTimeRange('帮我看看这个', now), null)
})

function task(partial: Partial<TaskRun> & { title: string }): TaskRun {
  return {
    id: 'run_x',
    title: partial.title,
    prompt: '',
    project: null,
    kind: 'task',
    priority: 5,
    dependsOn: [],
    retryOf: null,
    contract: null,
    status: 'done',
    target: null,
    sessionId: null,
    progress: null,
    progressHistory: [],
    artifacts: [],
    result: null,
    error: null,
    createdAt: new Date(now.getTime() - 2 * 86_400_000),
    startedAt: null,
    finishedAt: null,
    ...partial,
  } as TaskRun
}

function schedule(text: string, nextAt: Date): Scheduled {
  return { id: 'sch_x', text, nextAt, cron: null, everyMs: null, timezone: null, pausedAt: null } as Scheduled
}

test('formatRecentActivity：只算 7 天内，给出完成/失败与即将到来的日程', () => {
  const output = formatRecentActivity({
    now,
    tasks: [
      task({ title: '部署 0.1.5' }),
      task({ title: '旧任务', createdAt: new Date(now.getTime() - 30 * 86_400_000) }),
      task({ title: '迁移记忆', status: 'failed' }),
    ],
    schedules: [
      schedule('周会', new Date(now.getTime() + 3_600_000)),
      schedule('过期日程', new Date(now.getTime() - 3_600_000)),
    ],
  })
  assert.match(output, /完成 1，失败 1/)
  assert.match(output, /完成：部署 0\.1\.5/)
  assert.match(output, /失败：迁移记忆/)
  assert.match(output, /周会/)
  assert.ok(!output.includes('旧任务'))
  assert.ok(!output.includes('过期日程'))
})

test('formatRecentActivity：没数据时返回空串', () => {
  assert.equal(formatRecentActivity({ tasks: [], schedules: [], now }), '')
})
