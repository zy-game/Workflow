/**
 * 备份脚本的测试：快照可用、只保留最近 N 份、恢复前先留底。
 * 用真实的 SQLite 文件，不 mock —— 这条路径出错就等于数据没了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backupDatabase, restoreDatabase } from './backup.mjs'

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-backup-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function seed(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)')
  db.prepare('INSERT INTO notes (text) VALUES (?)').run('第一条')
  db.close()
}

function count(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM notes').get()
    return Number(row.n)
  } finally {
    db.close()
  }
}

test('backupDatabase：生成可用快照，数据完整', () =>
  withTempDir((dir) => {
    const dbPath = join(dir, 'qm.db')
    seed(dbPath)
    const file = backupDatabase({ dbPath, outDir: join(dir, 'backups'), keep: 3 })
    assert.match(file, /qm-\d{8}-\d{6}(-\d+)?\.db$/)
    assert.equal(count(file), 1)
  }))

test('backupDatabase：只保留最近 N 份', () =>
  withTempDir((dir) => {
    const dbPath = join(dir, 'qm.db')
    seed(dbPath)
    const outDir = join(dir, 'backups')
    backupDatabase({ dbPath, outDir, keep: 2 })
    backupDatabase({ dbPath, outDir, keep: 2 })
    backupDatabase({ dbPath, outDir, keep: 2 })
    const snapshots = readdirSync(outDir).filter((name) => name.endsWith('.db'))
    assert.equal(snapshots.length, 2)
  }))

test('restoreDatabase：覆盖前先把现库另存一份', () =>
  withTempDir((dir) => {
    const dbPath = join(dir, 'qm.db')
    const outDir = join(dir, 'backups')
    seed(dbPath)
    const snapshot = backupDatabase({ dbPath, outDir, keep: 3 })

    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT INTO notes (text) VALUES (?)').run('备份之后写的')
    db.close()
    assert.equal(count(dbPath), 2)

    const result = restoreDatabase({ dbPath, from: snapshot, outDir })
    assert.equal(count(dbPath), 1)
    assert.ok(result.previous && count(result.previous) === 2, '恢复前的库要能回滚')
  }))

test('backupDatabase：库不存在时直接报错，不生成空备份', () =>
  withTempDir((dir) => {
    assert.throws(() => backupDatabase({ dbPath: join(dir, 'missing.db'), outDir: join(dir, 'b') }), /数据库不存在/)
  }))
