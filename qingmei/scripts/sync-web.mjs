import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// 把构建产物同步到 Capacitor 的静态目录；config.js 是移动端专属配置，必须保留。
const root = path.resolve(import.meta.dirname, '..')
const dist = path.join(root, 'apps/web/dist')
const target = path.join(root, 'apps/mobile/www/app')
const configPath = path.join(target, 'config.js')

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('没有构建产物：先运行 pnpm web:build')
  process.exit(1)
}

const mobileConfig = existsSync(configPath)
  ? readFileSync(configPath)
  : Buffer.from("window.__QM_SERVER_URL = ''\nwindow.__QM_PERSIST_TOKEN__ = false\n")

rmSync(target, { recursive: true, force: true })
cpSync(dist, target, { recursive: true })
writeFileSync(configPath, mobileConfig)
console.log(`已同步 ${target}`)
