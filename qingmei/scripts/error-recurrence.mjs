#!/usr/bin/env node
/**
 * 「同类错误第二次少犯」的度量基线。
 *
 * 读 qm_turn 的 error_code（失败原因），按原因分组看重复：
 *   - 每个错误原因出现过几次、跨多少天；
 *   - 7 天内重复的原因占比（repeat7d）：越低说明教训越有效。
 *
 * 用法：node scripts/error-recurrence.mjs [--db data/qm.db]
 */
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}
const dbPath = path.resolve(argValue('--db', 'data/qm.db'))
const DAY = 86_400_000

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare("SELECT json FROM records WHERE name = 'qm_turn'")
  .all()
  .map((row) => JSON.parse(row.json))
  .filter((row) => row.status !== 'ok' && row.error_code)
  .sort((a, b) => a.created_at - b.created_at)

const groups = new Map()
for (const row of rows) {
  const code = String(row.error_code).slice(0, 80)
  const group = groups.get(code) ?? { code, times: [] }
  group.times.push(row.created_at)
  groups.set(code, group)
}

let repeatWithin7d = 0
const items = []
for (const group of groups.values()) {
  const first = group.times[0]
  const repeats = group.times.filter((at) => at > first && at - first <= 7 * DAY).length
  if (repeats > 0) repeatWithin7d += 1
  items.push({
    reason: group.code,
    count: group.times.length,
    days: Math.round((group.times[group.times.length - 1] - first) / DAY),
    repeatsWithin7d: repeats,
  })
}
items.sort((a, b) => b.count - a.count)

const report = {
  db: dbPath,
  failedTurns: rows.length,
  distinctReasons: groups.size,
  reasonsRepeatingWithin7d: repeatWithin7d,
  repeatRate: groups.size > 0 ? Number((repeatWithin7d / groups.size).toFixed(3)) : null,
  top: items.slice(0, 10),
}
console.log(JSON.stringify(report, null, 2))
