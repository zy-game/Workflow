import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

test('移动端首屏：固定服务器地址与 admin 登录', () => {
  const html = readFileSync(join(root, 'www', 'index.html'), 'utf8')
  assert.match(html, /139\.155\.78\.241:8710/)
  assert.match(html, /id="user"/)
  assert.match(html, /id="token"/)
  assert.doesNotMatch(html, /id="server"/)
  assert.match(html, /qm\.token/)
  assert.match(html, /\.\/pet\.html/)
})

test('移动端配置：固定 API 基址，令牌不写 localStorage', () => {
  execFileSync(process.execPath, [join(root, 'scripts', 'sync-web.mjs')], { cwd: root })
  const config = readFileSync(join(root, 'www', 'app', 'config.js'), 'utf8')
  assert.match(config, /__QM_SERVER_URL/)
  assert.match(config, /__QM_PERSIST_TOKEN__\s*=\s*false/)
})

test('桌宠主页：气泡、聊天入口与宠物资源', () => {
  execFileSync(process.execPath, [join(root, 'scripts', 'sync-web.mjs')], { cwd: root })
  const html = readFileSync(join(root, 'www', 'pet.html'), 'utf8')
  assert.match(html, /id="bubble"/)
  assert.match(html, /id="chat"/)
  assert.match(html, /idle-breath\.webm/)
  assert.ok(existsSync(join(root, 'www', 'pet', 'idle-breath.webm')))
})

test('桌宠菜单与聊天弹窗', () => {
  const html = readFileSync(join(root, 'www', 'pet.html'), 'utf8')
  assert.match(html, /id="menu"/)
  assert.match(html, /id="chat-sheet"/)
  assert.match(html, /data-action="chat"/)
  assert.match(html, /openChat\(\)/)
})
