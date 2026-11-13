import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { encryptSecret } from '@qingmei/core'
import { applyStoredSettings } from '../src/settings-bootstrap.ts'

test('启动时用库里的设置覆盖 env，且只认白名单前缀', () => {
  process.env.QM_TOKEN = 'boot-token'
  const dir = mkdtempSync(join(tmpdir(), 'qm-settings-boot-'))
  const dbPath = join(dir, 'qingmei.db')
  try {
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE records (name TEXT, id TEXT, json TEXT, created_at INTEGER, PRIMARY KEY (name, id))')
    const insert = db.prepare('INSERT INTO records (name, id, json, created_at) VALUES (?, ?, ?, ?)')
    insert.run(
      'qm_setting',
      'QM_LLM_KEY',
      JSON.stringify({ id: 'QM_LLM_KEY', value: encryptSecret('sk-from-db'), secret: true }),
      Date.now(),
    )
    insert.run(
      'qm_setting',
      'PATH',
      JSON.stringify({ id: 'PATH', value: '/evil', secret: false }),
      Date.now(),
    )
    db.close()

    process.env.QM_LLM_KEY = 'sk-from-env'
    applyStoredSettings(
      [{ name: '@qingmei/provider-store-sqlite', config: { path: dbPath } }],
      dir,
    )
    assert.equal(process.env.QM_LLM_KEY, 'sk-from-db')
    assert.notEqual(process.env.PATH, '/evil')
  } finally {
    delete process.env.QM_TOKEN
    delete process.env.QM_LLM_KEY
    rmSync(dir, { recursive: true, force: true })
  }
})
