import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPatchScope, isL3Path, l3Paths } from './patch-scope.mjs'

test('L3：核心层、安全面、发布管线一律拒绝', () => {
  for (const path of [
    'packages/core/src/index.ts',
    'packages/service-persona/src/index.ts',
    'packages/host-gateway/src/index.ts',
    'deploy/qingmei.service.current',
    'scripts/supervisor.mjs',
    'qingmei.prod.yml',
    './packages/core/src/index.ts',
    'packages\\core\\src\\index.ts',
  ]) {
    assert.equal(isL3Path(path), true, path)
  }
})

test('L3：普通业务路径允许', () => {
  for (const path of [
    'packages/qm-review/src/index.ts',
    'apps/web/public/app.js',
    'apps/mobile/www/index.html',
    'scripts/releases-helper.mjs',
  ]) {
    assert.equal(isL3Path(path), false, path)
  }
})

test('assertPatchScope 返回全部被拒路径', () => {
  assert.equal(assertPatchScope(['packages/qm-review/src/index.ts']), true)
  assert.deepEqual(l3Paths(['packages/core/a.ts', 'packages/core/a.ts', 'apps/web/a.js']), ['packages/core/a.ts'])
  assert.throws(
    () => assertPatchScope(['packages/qm-review/a.ts', 'deploy/x.conf']),
    /L3 路径/,
  )
})
