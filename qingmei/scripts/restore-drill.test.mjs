/**
 * 恢复演练脚本的测试：行数统计、差异检测、整条演练链路。
 * 演练本身不碰源库（只读），这条测试保证它不会误报“通过”。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { compareCounts, drill, tableCounts } from './restore-drill.mjs'

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-drill-'))
  const dbPath = join(dir, 'qm.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE records (name TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (name, id))')
  const insert = db.prepare('INSERT INTO records (name, id, json, created_at) VALUES (?, ?, ?, ?)')
  insert.run('qm_message', 'm1', '{}', 1)
  insert.run('qm_message', 'm2', '{}', 2)
  insert.run('qm_task_run', 'r1', '{}', 3)
  db.close()
  try {
    return run({ dir, dbPath })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('tableCounts：按集合统计行数', () => {
  withDb(({ dbPath }) => {
    assert.deepEqual(tableCounts(dbPath), { qm_message: 2, qm_task_run: 1 })
  })
})

test('compareCounts：只报不一致的表', () => {
  assert.deepEqual(compareCounts({ a: 1, b: 2 }, { a: 1, b: 2 }), [])
  assert.deepEqual(compareCounts({ a: 1, b: 2 }, { a: 1, b: 3 }), [{ name: 'b', expected: 2, actual: 3 }])
  assert.deepEqual(compareCounts({ a: 1 }, {}), [{ name: 'a', expected: 1, actual: 0 }])
})

test('drill：快照可恢复且行数一致', () => {
  withDb(({ dir, dbPath }) => {
    const result = drill({ dbPath, outDir: join(dir, 'backups') })
    assert.deepEqual(result.diffs, [])
    assert.equal(result.counts.qm_message, 2)
    assert.equal(result.restoredCounts.qm_message, 2)
  })
})
