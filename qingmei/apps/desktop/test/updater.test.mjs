/**
 * 桌面更新器的纯逻辑测试：版本比较、清单校验、校验和。
 * 这些判错一次就是「用户点更新却装了个旧包」或者「永远提示有更新」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { compareVersions, parseManifest, pickUpdate, sha256File } = require('../electron/updater.cjs')

const MANIFEST = {
  version: '0.1.4',
  url: 'https://example.test/updates/desktop/Qingmei-Setup-0.1.4.exe',
  sha256: 'a'.repeat(64),
  size: 123,
  notes: '修了几处',
}

test('compareVersions：按数字比较，0.1.10 大于 0.1.9', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1)
  assert.equal(compareVersions('0.1.9', '0.1.10'), -1)
  assert.equal(compareVersions('0.1.4', '0.1.4'), 0)
  assert.equal(compareVersions('v0.2.0', '0.1.9'), 1)
})

test('parseManifest：合法清单解析成对象', () => {
  const parsed = parseManifest(JSON.stringify(MANIFEST))
  assert.equal(parsed.version, '0.1.4')
  assert.equal(parsed.url, MANIFEST.url)
  assert.equal(parsed.sha256, MANIFEST.sha256)
})

test('parseManifest：字段不合法时返回 null，不抛错', () => {
  assert.equal(parseManifest('not json'), null)
  assert.equal(parseManifest({ ...MANIFEST, sha256: 'abc' }), null)
  assert.equal(parseManifest({ ...MANIFEST, version: 'v0.1' }), null)
  assert.equal(parseManifest({ ...MANIFEST, url: 'ftp://x/y.exe' }), null)
})

test('pickUpdate：只在新版本时返回清单', () => {
  assert.equal(pickUpdate('0.1.3', MANIFEST)?.version, '0.1.4')
  assert.equal(pickUpdate('0.1.4', MANIFEST), null)
  assert.equal(pickUpdate('0.1.5', MANIFEST), null)
  assert.equal(pickUpdate('0.1.3', null), null)
})

test('sha256File：与独立计算一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-updater-'))
  try {
    const file = join(dir, 'setup.exe')
    writeFileSync(file, 'installer-bytes')
    const expected = createHash('sha256').update('installer-bytes').digest('hex')
    assert.equal(await sha256File(file), expected)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
