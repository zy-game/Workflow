#!/usr/bin/env node
/**
 * 生成桌面更新源：安装包 + latest.json。
 *
 * 更新器（apps/desktop/electron/updater.cjs）读 /updates/desktop/latest.json，
 * 按 sha256 校验后静默运行安装包。任意旧版本都能一步升到最新，
 * 不需要 electron-updater 的 latest.yml / blockmap，也不再要求 NSIS。
 *
 * 用法：
 *   node scripts/release-desktop.mjs --file apps/desktop/dist/Qingmei-Setup-0.1.4.exe --version 0.1.4
 *   node scripts/release-desktop.mjs --file <exe> --version <x.y.z> --notes "本版改了什么"
 *   node scripts/release-desktop.mjs --file <exe> --version <x.y.z> --zip <portable.zip>
 * 产物：updates/desktop/Qingmei-Setup-<version>.exe + latest.json（可选 portable ZIP）
 */
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const BASE_URL = 'https://139.155.78.241:8710/updates/desktop'

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

export function latestJson({ version, url, sha256, size, notes = '', at = new Date() }) {
  return `${JSON.stringify({ version, url, sha256, size, notes, at: at.toISOString() }, null, 2)}\n`
}

export async function stage({ file, version, outDir, notes = '', zip = '' }) {
  if (!existsSync(file)) throw new Error(`安装包不存在：${file}`)
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本号必须形如 0.1.4：${version}`)
  mkdirSync(outDir, { recursive: true })
  const name = `Qingmei-Setup-${version}.exe`
  const target = path.join(outDir, name)
  if (path.resolve(file) !== path.resolve(target)) copyFileSync(file, target)
  const sha256 = await sha256File(target)
  const size = statSync(target).size
  const manifest = latestJson({ version, url: `${BASE_URL}/${name}`, sha256, size, notes })
  writeFileSync(path.join(outDir, 'latest.json'), manifest, 'utf8')

  let portable = ''
  if (zip && existsSync(zip)) {
    portable = path.join(outDir, `qingmei-desktop-${version}-portable.zip`)
    copyFileSync(zip, portable)
  }
  return { target, latest: path.join(outDir, 'latest.json'), sha256, size, portable }
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
  if (!args.file || !args.version) throw new Error('用法：--file <安装包> --version <x.y.z> [--notes 文本] [--zip 便携包] [--out 目录]')
  const outDir = path.resolve(args.out ?? path.join(REPO_ROOT, 'updates', 'desktop'))
  const result = await stage({
    file: path.resolve(args.file),
    version: String(args.version),
    outDir,
    notes: String(args.notes ?? ''),
    zip: args.zip ? path.resolve(String(args.zip)) : '',
  })
  console.log(`✔ ${result.target}（${Math.round(result.size / 1024 / 1024)} MB）`)
  console.log(`✔ ${result.latest}`)
  if (result.portable) console.log(`✔ ${result.portable}`)
  console.log('')
  console.log('上传：')
  console.log(`  scp -i ~/.ssh/company.pem "${outDir}"/* ubuntu@139.155.78.241:/opt/qingmei/updates/desktop/`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[release-desktop] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
