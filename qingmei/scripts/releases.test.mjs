import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activateRelease, createRelease, listReleases, pruneReleases } from './releases.mjs'

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-releases-'))
  const app = join(dir, 'app')
  mkdirSync(join(app, 'apps', 'server'), { recursive: true })
  mkdirSync(join(app, 'data'), { recursive: true })
  writeFileSync(join(app, 'apps', 'server', 'index.ts'), 'v1')
  writeFileSync(join(app, 'qingmei.yml'), 'live-config')
  writeFileSync(join(app, 'data', 'qm.db'), 'live-data')
  return { dir, app, releases: join(app, 'releases') }
}

test('创建 release 不含 data/config，回滚恢复代码并保留数据', async () => {
  const h = makeApp()
  try {
    const first = await createRelease(h.app, h.releases, { id: 'r1', note: 'v1' })
    assert.equal(first.id, 'r1')
    assert.equal(existsSync(join(h.releases, 'r1', 'data')), false)
    assert.equal(existsSync(join(h.releases, 'r1', 'qingmei.yml')), false)
    assert.equal(readFileSync(join(h.releases, 'r1', 'apps', 'server', 'index.ts'), 'utf8'), 'v1')

    writeFileSync(join(h.app, 'apps', 'server', 'index.ts'), 'v2')
    const second = await createRelease(h.app, h.releases, { id: 'r2' })
    assert.equal(second.id, 'r2')

    const listed = await listReleases(h.releases)
    assert.equal(listed.length, 2)

    const rolled = await activateRelease(h.app, h.releases, 'r1')
    assert.match(rolled.safety, /^pre-rollback-/)
    assert.equal(readFileSync(join(h.app, 'apps', 'server', 'index.ts'), 'utf8'), 'v1')
    assert.equal(readFileSync(join(h.app, 'data', 'qm.db'), 'utf8'), 'live-data')
    assert.equal(readFileSync(join(h.app, 'qingmei.yml'), 'utf8'), 'live-config')
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('prune 只保留最近 N 个 release', async () => {
  const h = makeApp()
  try {
    for (const id of ['r1', 'r2', 'r3']) {
      await createRelease(h.app, h.releases, { id })
    }
    const removed = await pruneReleases(h.releases, 2)
    assert.equal(removed, 1)
    assert.equal((await listReleases(h.releases)).length, 2)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})
