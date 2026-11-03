import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureSafeConfig, isConfigTextValid, listSnapshots } from '../src/config-safety.ts'

const VALID = "- name: '@qingmei/service-store'\n  config:\n    path: ./data/qm.db\n"

test('S2：合法配置落快照并按内容去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-config-'))
  const file = join(dir, 'qingmei.yml')
  writeFileSync(file, VALID)
  try {
    const first = ensureSafeConfig(file)
    assert.equal(first.ok, true)
    assert.equal(first.repaired, false)
    assert.equal(listSnapshots(join(dir, 'config-snapshots')).length, 1)

    ensureSafeConfig(file)
    assert.equal(listSnapshots(join(dir, 'config-snapshots')).length, 1, '同内容不重复快照')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S2：配置损坏时回滚最近快照并保留损坏文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-config-'))
  const file = join(dir, 'qingmei.yml')
  writeFileSync(file, VALID)
  try {
    ensureSafeConfig(file)
    writeFileSync(file, 'name: [broken\n')
    const repaired = ensureSafeConfig(file)
    assert.equal(repaired.ok, true)
    assert.equal(repaired.repaired, true)
    assert.ok(repaired.broken && existsSync(repaired.broken))
    assert.equal(readFileSync(file, 'utf8'), VALID)
    assert.ok(readdirSync(dir).some((name) => name.includes('.broken-')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S2：无快照时报告错误，不伪造配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-config-'))
  const file = join(dir, 'qingmei.yml')
  try {
    const result = ensureSafeConfig(file)
    assert.equal(result.ok, false)
    assert.equal(result.repaired, false)
    assert.equal(existsSync(file), false)
    assert.equal(isConfigTextValid('- name: x\n'), true)
    assert.equal(isConfigTextValid('[]'), true)
    assert.equal(isConfigTextValid('- config: {}\n'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
