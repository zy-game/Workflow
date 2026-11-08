import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

test('架构严格门禁：0 reflect 且 0 跨插件 collection', () => {
  const output = execFileSync(process.execPath, ['scripts/check-architecture.mjs', '--strict'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.match(output, /Cordis 架构报告：0 处 ctx\.reflect\.get/)
  assert.match(output, /collection 越界：0 处/)
})
