#!/usr/bin/env node
/**
 * 生成桌面更新源：把安装包与 latest.yml 放到一个可直接上传的目录。
 *
 * 背景：electron-updater 读 /updates/latest.yml，靠 sha512 校验安装包。
 * 之前线上 latest.yml 停在 0.1.2，且 releaseDate 字段是一次 PowerShell 表达式
 * 没展开就写进去了（不是合法日期），客户端可能因此不认。
 *
 * 用法：
 *   node scripts/release-desktop.mjs --file "E:/Workflow/qingmei-setup-0.1.3.exe" --version 0.1.3
 *   node scripts/release-desktop.mjs --file apps/desktop/dist/"青梅 Setup 0.1.3.exe" --version 0.1.3
 * 产物：updates/desktop/Qingmei-Setup-<version>.exe + latest.yml
 */
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

/** electron-builder 的 latest.yml 需要 base64 的 sha512，不是十六进制 */
export function sha512Base64(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')))
      .on('error', reject)
  })
}

export function latestYml({ version, url, sha512, size, releaseDate = new Date() }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate.toISOString()}'`,
    '',
  ].join('\n')
}

export async function stage({ file, version, outDir }) {
  if (!existsSync(file)) throw new Error(`安装包不存在：${file}`)
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本号必须形如 0.1.3：${version}`)
  mkdirSync(outDir, { recursive: true })
  const name = `Qingmei-Setup-${version}.exe`
  const target = path.join(outDir, name)
  if (path.resolve(file) !== path.resolve(target)) copyFileSync(file, target)
  const sha512 = await sha512Base64(target)
  const size = statSync(target).size
  const manifest = latestYml({ version, url: name, sha512, size })
  writeFileSync(path.join(outDir, 'latest.yml'), manifest, 'utf8')
  return { target, latest: path.join(outDir, 'latest.yml'), sha512, size }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    args[key.slice(2)] = argv[i + 1]
    i += 1
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const file = path.resolve(args.file ?? '')
  const version = String(args.version ?? '')
  const outDir = path.resolve(args.out ?? path.join(REPO_ROOT, 'updates', 'desktop'))
  if (!args.file || !version) throw new Error('用法：--file <安装包> --version <x.y.z> [--out <目录>]')
  const result = await stage({ file, version, outDir })
  console.log(`✔ ${result.target}（${Math.round(result.size / 1024 / 1024)} MB）`)
  console.log(`✔ ${result.latest}`)
  console.log('')
  console.log('上传（示例）：')
  console.log(`  scp -i ~/.ssh/company.pem "${result.target}" "${result.latest}" ubuntu@139.155.78.241:/opt/qingmei/updates/`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[release-desktop] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
