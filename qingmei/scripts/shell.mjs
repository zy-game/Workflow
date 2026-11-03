#!/usr/bin/env node
/**
 * P5 · 外壳切换（最小版）。
 *
 * root/
 *   releases/<id>/...   代码（由 releases.mjs 创建）
 *   current -> releases/<id>
 *   data/ qingmei.yml   运行数据与配置
 *
 * activate 用临时 symlink + rename 原子切换；服务 unit 需要把 ExecStart 指向
 * current/apps/server/src/index.ts，并显式 --config root/qingmei.yml。
 * 当前生产 unit 尚未切换到该模式，因此这是可选外壳，不是已启用的运行路径。
 */
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function activate(rootDir, id) {
  const root = path.resolve(rootDir)
  const release = path.join(root, 'releases', id)
  if (!existsSync(path.join(release, 'apps', 'server', 'src', 'index.ts'))) {
    throw new Error(`release 不存在或缺少 apps/server：${id}`)
  }
  const current = path.join(root, 'current')
  const temp = path.join(root, `.current-${Date.now()}`)
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(release, temp, type)
  if (process.platform === 'win32' && existsSync(current)) {
    // Windows 上不能原子覆盖目录 junction：先删再换
    await rm(current, { recursive: true, force: true })
  }
  await rename(temp, current)
  return { current, release }
}

export async function linkDependencies(rootDir, id) {
  const root = path.resolve(rootDir)
  const release = path.join(root, 'releases', id)
  if (!existsSync(path.join(release, 'apps'))) throw new Error(`release 不存在：${id}`)
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  let linked = 0
  const link = async (source, target) => {
    if (!existsSync(source)) return
    await rm(target, { recursive: true, force: true })
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(source, target, type)
    linked += 1
  }
  await link(path.join(root, 'node_modules'), path.join(release, 'node_modules'))
  for (const group of ['apps', 'packages']) {
    const parent = path.join(root, group)
    if (!existsSync(parent)) continue
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      await link(
        path.join(parent, entry.name, 'node_modules'),
        path.join(release, group, entry.name, 'node_modules'),
      )
    }
  }
  return linked
}
export async function currentRelease(rootDir) {
  const current = path.join(path.resolve(rootDir), 'current')
  if (!existsSync(current)) return null
  const info = await lstat(current)
  if (!info.isSymbolicLink()) return { path: current, release: null }
  const target = await readlink(current)
  return { path: current, release: path.basename(target) }
}

export async function listReleaseIds(rootDir) {
  const releases = path.join(path.resolve(rootDir), 'releases')
  if (!existsSync(releases)) return []
  return (await readdir(releases, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'current'
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : '/opt/qingmei'
  if (command === 'activate') {
    const id = args[1]
    if (!id) throw new Error('用法：shell.mjs activate <release-id> [--root <dir>]')
    console.log(JSON.stringify(await activate(root, id)))
    return
  }
  if (command === 'prepare') {
    const id = args[1]
    if (!id) throw new Error('用法：shell.mjs prepare <release-id> [--root <dir>]')
    console.log(JSON.stringify({ id, linked: await linkDependencies(root, id) }))
    return
    return
  }
  if (command === 'current') {
    console.log(JSON.stringify(await currentRelease(root)))
    return
  }
  if (command === 'list') {
    console.log(JSON.stringify(await listReleaseIds(root), null, 2))
    return
  }
  throw new Error(`未知命令：${command}`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[shell] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
