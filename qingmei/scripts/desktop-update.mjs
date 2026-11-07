#!/usr/bin/env node
/**
 * 生成桌面更新源文件：latest.yml + ASCII 安装包名。
 * 用法：node scripts/desktop-update.mjs [--file <nsis.exe>]
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const fileArg = args.includes('--file') ? args[args.indexOf('--file') + 1] : ''
const version = JSON.parse(readFileSync(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8')).version
const source =
  fileArg ||
  path.join(root, 'apps', 'desktop', 'dist', `青梅 Setup ${version}.exe`)
if (!existsSync(source)) {
  console.error(`[update] 找不到安装包：${source}，先运行 pnpm --filter qingmei-desktop dist:nsis`)
  process.exit(1)
}
const name = `Qingmei-Setup-${version}.exe`
const target = path.join(root, 'apps', 'desktop', 'dist', name)
copyFileSync(source, target)
const data = readFileSync(target)
const sha512 = createHash('sha512').update(data).digest('base64')
const latest = `version: ${version}
files:
  - url: ${name}
    sha512: ${sha512}
    size: ${statSync(target).size}
path: ${name}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`
const latestPath = path.join(root, 'apps', 'desktop', 'dist', 'latest.yml')
writeFileSync(latestPath, latest)
console.log(`[update] ${target}`)
console.log(`[update] ${latestPath}`)
console.log(`[update] 上传到服务器 /opt/qingmei/updates/ 后，客户端会从 QM_UPDATE_URL（默认生产 /updates）检查`)
