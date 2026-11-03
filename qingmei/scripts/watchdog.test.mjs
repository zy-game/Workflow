import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreCode, watchdogOnce } from './watchdog.mjs'

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-watchdog-'))
  const app = join(dir, 'app')
  const backup = join(dir, 'app.prev')
  for (const root of [app, backup]) {
    mkdirSync(join(root, 'apps', 'server'), { recursive: true })
    mkdirSync(join(root, 'data'), { recursive: true })
  }
  writeFileSync(join(app, 'apps', 'server', 'index.ts'), 'v2')
  writeFileSync(join(backup, 'apps', 'server', 'index.ts'), 'v1')
  writeFileSync(join(app, 'data', 'qm.db'), 'live-data')
  writeFileSync(join(app, 'qingmei.yml'), 'live-config')
  writeFileSync(join(backup, 'qingmei.yml'), 'old-config')
  return { dir, app, backup, state: join(dir, 'state.json') }
}

test('恢复代码时保留 data 与 qingmei.yml', async () => {
  const h = makeApp()
  try {
    const copied = await restoreCode(h.app, h.backup)
    assert.ok(copied >= 1)
    assert.equal(readFileSync(join(h.app, 'apps', 'server', 'index.ts'), 'utf8'), 'v1')
    assert.equal(readFileSync(join(h.app, 'data', 'qm.db'), 'utf8'), 'live-data')
    assert.equal(readFileSync(join(h.app, 'qingmei.yml'), 'utf8'), 'live-config')
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('连续失败达到阈值才回滚并重启', async () => {
  const h = makeApp()
  let restarts = 0
  try {
    const first = await watchdogOnce({
      appDir: h.app,
      backupDir: h.backup,
      healthUrl: 'http://unused',
      stateFile: h.state,
      threshold: 2,
      probe: async () => false,
      restart: async () => {
        restarts += 1
      },
    })
    assert.deepEqual(first, { action: 'waiting', fails: 1, restored: 0 })
    assert.equal(restarts, 0)

    const second = await watchdogOnce({
      appDir: h.app,
      backupDir: h.backup,
      healthUrl: 'http://unused',
      stateFile: h.state,
      threshold: 2,
      probe: async () => false,
      restart: async () => {
        restarts += 1
      },
    })
    assert.equal(second.action, 'rolled-back')
    assert.equal(restarts, 1)
    assert.equal(readFileSync(join(h.app, 'apps', 'server', 'index.ts'), 'utf8'), 'v1')

    const healthy = await watchdogOnce({
      appDir: h.app,
      backupDir: h.backup,
      healthUrl: 'http://unused',
      stateFile: h.state,
      threshold: 2,
      probe: async () => true,
    })
    assert.equal(healthy.action, 'healthy')
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})
