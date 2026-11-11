/**
 * 导出脚本的测试：按集合取行、缺少集合不报错、secret 事实默认不出去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { exportDatabase, listCollections } from './export.mjs'

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-export-'))
  const dbPath = join(dir, 'qm.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE records (name TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (name, id))')
  const insert = db.prepare('INSERT INTO records (name, id, json, created_at) VALUES (?, ?, ?, ?)')
  const push = (name, id, row, at) => insert.run(name, id, JSON.stringify(row), at)
  push('qm_mem_fact', 'f1', { id: 'f1', subject: '主人', object: '喜欢喝美式', sensitivity: 'private' }, 1)
  push('qm_mem_fact', 'f2', { id: 'f2', subject: '主人', object: '银行卡密码', sensitivity: 'secret' }, 2)
  push('qm_task_run', 'r1', { id: 'r1', title: '跑测试', status: 'done' }, 3)
  db.close()
  try {
    return run({ dir, dbPath })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('listCollections：按名字列出集合', () => {
  withDb(({ dbPath }) => {
    assert.deepEqual(listCollections(dbPath), ['qm_mem_fact', 'qm_task_run'])
  })
})

test('exportDatabase：默认剔除 secret 事实，缺的集合只记录不报错', () => {
  withDb(({ dbPath }) => {
    const payload = exportDatabase({ dbPath })
    assert.equal(payload.counts.qm_mem_fact, 1)
    assert.equal(payload.counts.qm_task_run, 1)
    assert.equal(payload.collections.qm_mem_fact[0].object, '喜欢喝美式')
    assert.ok(payload.missing.includes('qm_schedule'))
    assert.equal(payload.includeSecret, false)
  })
})

test('exportDatabase：--include-secret 才带出敏感事实', () => {
  withDb(({ dbPath }) => {
    const payload = exportDatabase({ dbPath, includeSecret: true })
    assert.equal(payload.counts.qm_mem_fact, 2)
  })
})

test('exportDatabase：库不存在时直接报错', () => {
  assert.throws(() => exportDatabase({ dbPath: join(tmpdir(), 'qm-no-such.db') }), /数据库不存在/)
})
