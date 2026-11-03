#!/usr/bin/env node
/**
 * P5 · 版本目录管理（最小版）。
 *
 * 不改变 systemd 的 WorkingDirectory=/opt/qingmei；release 是代码的只读副本。
 * - create：把当前代码（排除 data/node_modules/qingmei.yml 等）复制到 releases/<id>
 * - list：列出 release
 * - rollback <id>：把 release 代码复制回 app，保留 data/qingmei.yml/config-snapshots
 *
 * 这不是不可变外壳（运行目录仍可写），但能提供可审计、可回滚的版本目录。
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const PRESERVE = new Set([
  'data',
  'node_modules',
  '.git',
  'releases',
  'config-snapshots',
  'qingmei.yml',
  'tmp',
  'dist',
])

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) {
      args._.push(item)
      continue
    }
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      index += 1
    } else {
      args[key] = true
    }
  }
  return args
}

async function copyCode(from, to) {
  const entries = await readdir(from, { withFileTypes: true })
  let copied = 0
  for (const entry of entries) {
    if (PRESERVE.has(entry.name)) continue
    await cp(path.join(from, entry.name), path.join(to, entry.name), { recursive: true, force: true })
    copied += 1
  }
  return copied
}

export async function createRelease(appDir, releasesDir, options = {}) {
  await mkdir(releasesDir, { recursive: true })
  const id = options.id ?? new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(releasesDir, id)
  if (existsSync(target)) throw new Error(`release 已存在：${id}`)
  await mkdir(target, { recursive: true })
  const files = await copyCode(appDir, target)
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    files,
    note: options.note ?? '',
  }
  await writeFile(path.join(target, 'release.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return manifest
}

export async function listReleases(releasesDir) {
  if (!existsSync(releasesDir)) return []
  const entries = await readdir(releasesDir, { withFileTypes: true })
  const releases = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(releasesDir, entry.name, 'release.json')
    if (!existsSync(manifestPath)) continue
    try {
      releases.push(JSON.parse(await readFile(manifestPath, 'utf8')))
    } catch {
      // 坏 manifest 跳过
    }
  }
  return releases.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export async function activateRelease(appDir, releasesDir, id) {
  const source = path.join(releasesDir, id)
  if (!existsSync(path.join(source, 'release.json'))) throw new Error(`release 不存在：${id}`)
  const safety = await createRelease(appDir, releasesDir, {
    id: `pre-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    note: `rollback to ${id}`,
  })
  const files = await copyCode(source, appDir)
  return { id, safety: safety.id, files }
}

export async function pruneReleases(releasesDir, keep = 20) {
  const releases = await listReleases(releasesDir)
  for (const release of releases.slice(keep)) {
    await rm(path.join(releasesDir, release.id), { recursive: true, force: true })
  }
  return Math.max(0, releases.length - keep)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const appDir = path.resolve(args.app ?? '/opt/qingmei')
  const releasesDir = path.resolve(args.releases ?? path.join(appDir, 'releases'))
  const command = args._[0] ?? 'list'
  if (command === 'create') {
    const manifest = await createRelease(appDir, releasesDir, {
      ...(typeof args.id === 'string' ? { id: args.id } : {}),
      ...(typeof args.note === 'string' ? { note: args.note } : {}),
    })
    await pruneReleases(releasesDir)
    console.log(JSON.stringify(manifest))
    return
  }
  if (command === 'list') {
    console.log(JSON.stringify(await listReleases(releasesDir), null, 2))
    return
  }
  if (command === 'rollback') {
    const id = typeof args._[1] === 'string' ? args._[1] : ''
    if (!id) throw new Error('用法：releases.mjs rollback <id>')
    console.log(JSON.stringify(await activateRelease(appDir, releasesDir, id)))
    return
  }
  throw new Error(`未知命令：${command}`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[releases] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
