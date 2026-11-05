import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

test('移动端首屏：服务器/令牌表单与本地保存键', () => {
  const html = readFileSync(join(root, 'www', 'index.html'), 'utf8')
  assert.match(html, /id="server"/)
  assert.match(html, /id="token"/)
  assert.match(html, /qm\.server/)
  assert.match(html, /qm\.token/)
  assert.match(html, /\.\/app\/index\.html/)
})

test('移动端配置：固定 API 基址并持久化令牌', () => {
  execFileSync(process.execPath, [join(root, 'scripts', 'sync-web.mjs')], { cwd: root })
  const config = readFileSync(join(root, 'www', 'app', 'config.js'), 'utf8')
  assert.match(config, /__QM_SERVER_URL/)
  assert.match(config, /__QM_PERSIST_TOKEN__\s*=\s*true/)
})
