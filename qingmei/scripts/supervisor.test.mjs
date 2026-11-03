import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deployWithRollback, rollbackTo } from './supervisor.mjs'

async function setup(version = 'old') {
  const dir = await mkdtemp(join(tmpdir(), 'qm-supervisor-'))
  const appDir = join(dir, 'app')
  const backupDir = join(dir, 'app.prev')
  await mkdir(join(appDir, 'data'), { recursive: true })
  await writeFile(join(appDir, 'version.txt'), version)
  await writeFile(join(appDir, 'data', 'keep.txt'), 'precious')
  return {
    dir,
    appDir,
    backupDir,
    async dispose() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('部署健康：直接返回 ok', async () => {
  const h = await setup()
  try {
    let restarts = 0
    const result = await deployWithRollback({
      appDir: h.appDir,
      backupDir: h.backupDir,
      extract: async () => writeFile(join(h.appDir, 'version.txt'), 'new'),
      restart: async () => {
        restarts += 1
      },
      health: async () => (await readFile(join(h.appDir, 'version.txt'), 'utf8')) === 'new',
      timeoutMs: 200,
    })
    assert.deepEqual(result, { ok: true, rolledBack: false, healthy: true })
    assert.equal(restarts, 1)
  } finally {
    await h.dispose()
  }
})

test('新版本不健康：回滚到旧版本，保留 data 目录', async () => {
  const h = await setup('old')
  try {
    let restarts = 0
    const result = await deployWithRollback({
      appDir: h.appDir,
      backupDir: h.backupDir,
      extract: async () => writeFile(join(h.appDir, 'version.txt'), 'new'),
      restart: async () => {
        restarts += 1
      },
      health: async () => (await readFile(join(h.appDir, 'version.txt'), 'utf8')) === 'old',
      timeoutMs: 200,
    })
    assert.deepEqual(result, { ok: false, rolledBack: true, healthy: true })
    assert.equal(restarts, 2, '重启两次：新版本一次、回滚一次')
    assert.equal(await readFile(join(h.appDir, 'version.txt'), 'utf8'), 'old')
    assert.equal(await readFile(join(h.appDir, 'data', 'keep.txt'), 'utf8'), 'precious', 'data 不能被回滚删掉')
  } finally {
    await h.dispose()
  }
})

test('回滚后仍不健康：交由人工', async () => {
  const h = await setup('old')
  try {
    const result = await deployWithRollback({
      appDir: h.appDir,
      backupDir: h.backupDir,
      extract: async () => writeFile(join(h.appDir, 'version.txt'), 'new'),
      restart: async () => undefined,
      health: async () => false,
      timeoutMs: 150,
    })
    assert.deepEqual(result, { ok: false, rolledBack: true, healthy: false })
  } finally {
    await h.dispose()
  }
})

test('回滚到指定历史版本', async () => {
  const h = await setup('new')
  try {
    const fromDir = join(h.dir, 'old-release')
    await mkdir(fromDir, { recursive: true })
    await writeFile(join(fromDir, 'version.txt'), 'old')
    const result = await rollbackTo({
      appDir: h.appDir,
      fromDir,
      restart: async () => undefined,
      health: async () => (await readFile(join(h.appDir, 'version.txt'), 'utf8')) === 'old',
      timeoutMs: 200,
    })
    assert.deepEqual(result, { ok: true, healthy: true, from: fromDir })
    assert.equal(await readFile(join(h.appDir, 'version.txt'), 'utf8'), 'old')
  } finally {
    await h.dispose()
  }
})

test('shell 钩子：先切 release，健康失败切回旧 release', async () => {
  const h = await setup('old')
  try {
    const calls = []
    const result = await deployWithRollback({
      appDir: h.appDir,
      backupDir: h.backupDir,
      extract: async () => writeFile(join(h.appDir, 'version.txt'), 'new'),
      beforeRestart: async () => {
        calls.push('activate')
      },
      rollbackRelease: async () => {
        calls.push('rollback-release')
      },
      restart: async () => {
        calls.push('restart')
      },
      health: async () => false,
      timeoutMs: 150,
    })
    assert.equal(result.healthy, false)
    assert.equal(calls[0], 'activate')
    assert.ok(calls.indexOf('rollback-release') > calls.indexOf('activate'))
    assert.equal(await readFile(join(h.appDir, 'version.txt'), 'utf8'), 'old')
    assert.equal(await readFile(join(h.appDir, 'data', 'keep.txt'), 'utf8'), 'precious')
  } finally {
    await h.dispose()
  }
})
