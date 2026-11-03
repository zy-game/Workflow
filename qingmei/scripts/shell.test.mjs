import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activate, currentRelease, listReleaseIds } from './shell.mjs'

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'qm-shell-'))
  for (const id of ['r1', 'r2']) {
    const dir = join(root, 'releases', id, 'apps', 'server', 'src')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.ts'), `// ${id}`)
  }
  return root
}

test('current 外壳：原子切换到指定 release', async () => {
  const root = makeRoot()
  try {
    assert.deepEqual(await listReleaseIds(root), ['r2', 'r1'])
    assert.equal(await currentRelease(root), null)
    await activate(root, 'r1')
    assert.equal((await currentRelease(root))?.release, 'r1')
    await activate(root, 'r2')
    assert.equal((await currentRelease(root))?.release, 'r2')
    await assert.rejects(() => activate(root, 'nope'), /release 不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
