import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
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
  assert.match(html, /\.\/app\/index\.html/)
})

test('移动端配置：固定 API 基址，令牌不写 localStorage', () => {
  execFileSync(process.execPath, [join(root, 'scripts', 'sync-web.mjs')], { cwd: root })
  const config = readFileSync(join(root, 'www', 'app', 'config.js'), 'utf8')
  assert.match(config, /__QM_SERVER_URL = 'https:\/\/139\.155\.78\.241:8710'/)
  assert.match(config, /__QM_PERSIST_TOKEN__\s*=\s*false/)
})

test('主界面直接聊天，并提供悬浮入口', () => {
  execFileSync(process.execPath, [join(root, 'scripts', 'sync-web.mjs')], { cwd: root })
  const html = readFileSync(join(root, 'www', 'index.html'), 'utf8')
  assert.match(html, /app\/index\.html/)
  // Vue 构建产物按视图分包；悬浮入口在打包后的字符串里，扫全部 js 块
  const assets = join(root, 'www', 'app', 'assets')
  const app = readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(assets, name), 'utf8'))
    .join('\n')
  assert.match(app, /PetOverlay/)
  assert.match(app, /悬浮到桌面/)
})
