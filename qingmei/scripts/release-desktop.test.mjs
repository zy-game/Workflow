/**
 * 桌面更新源生成的测试。
 * latest.yml 的 sha512 必须是 base64（electron-builder 的约定），
 * 写成十六进制客户端会一直判定校验失败。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestYml, stage } from './release-desktop.mjs'

async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'qm-release-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('latestYml：字段齐全，releaseDate 是合法 ISO 时间', () => {
  const text = latestYml({
    version: '0.1.3',
    url: 'Qingmei-Setup-0.1.3.exe',
    sha512: 'abc=',
    size: 123,
    releaseDate: new Date('2026-11-11T03:00:00.000Z'),
  })
  assert.match(text, /^version: 0\.1\.3$/m)
  assert.match(text, /^ {2}- url: Qingmei-Setup-0\.1\.3\.exe$/m)
  assert.match(text, /^releaseDate: '2026-11-11T03:00:00\.000Z'$/m)
  assert.match(text, /^sha512: abc=$/m)
  assert.doesNotMatch(text, /ToUniversalTime|ToString/, '不能再把 PowerShell 表达式写进字段')
})

test('stage：复制安装包并按内容算 base64 sha512', () =>
  withTempDir(async (dir) => {
    const file = join(dir, 'build.exe')
    writeFileSync(file, 'not-really-an-installer')
    const expected = createHash('sha512').update('not-really-an-installer').digest('base64')

    const result = await stage({ file, version: '0.1.3', outDir: join(dir, 'updates') })
    assert.equal(result.sha512, expected)
    assert.equal(result.size, 'not-really-an-installer'.length)
    const manifest = readFileSync(result.latest, 'utf8')
    assert.ok(manifest.includes(expected))
    assert.ok(manifest.includes('Qingmei-Setup-0.1.3.exe'))
  }))

test('stage：版本号格式不对直接报错', () =>
  withTempDir(async (dir) => {
    const file = join(dir, 'build.exe')
    writeFileSync(file, 'x')
    await assert.rejects(() => stage({ file, version: 'v0.1', outDir: join(dir, 'u') }), /版本号必须形如/)
  }))
