/**
 * 桌面更新源生成的测试。
 * 清单字段错了，客户端要么永远不更新，要么装到校验失败的包。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestJson, stage } from './release-desktop.mjs'

async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-release-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('latestJson：字段齐全，at 是合法 ISO 时间', () => {
  const text = latestJson({
    version: '0.1.4',
    url: 'https://example.test/updates/desktop/Qingmei-Setup-0.1.4.exe',
    sha256: 'a'.repeat(64),
    size: 123,
    notes: '修了几处',
    at: new Date('2026-11-11T03:00:00.000Z'),
  })
  const parsed = JSON.parse(text)
  assert.equal(parsed.version, '0.1.4')
  assert.equal(parsed.sha256, 'a'.repeat(64))
  assert.equal(parsed.at, '2026-11-11T03:00:00.000Z')
  assert.equal(parsed.notes, '修了几处')
})

test('stage：复制安装包并按内容算 sha256，清单指向公网地址', () =>
  withTempDir(async (dir) => {
    const file = join(dir, 'setup.exe')
    writeFileSync(file, 'installer-bytes')
    const expected = createHash('sha256').update('installer-bytes').digest('hex')

    const result = await stage({ file, version: '0.1.4', outDir: join(dir, 'updates'), notes: 'note' })
    assert.equal(result.sha256, expected)
    const manifest = JSON.parse(readFileSync(result.latest, 'utf8'))
    assert.equal(manifest.url, 'https://139.155.78.241:8710/updates/desktop/Qingmei-Setup-0.1.4.exe')
    assert.equal(manifest.size, 'installer-bytes'.length)
    assert.equal(manifest.sha256, expected)
  }))

test('stage：版本号格式不对直接报错', () =>
  withTempDir(async (dir) => {
    const file = join(dir, 'setup.exe')
    writeFileSync(file, 'x')
    await assert.rejects(() => stage({ file, version: 'v0.1', outDir: join(dir, 'u') }), /版本号必须形如/)
  }))
