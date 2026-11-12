#!/usr/bin/env node
/**
 * 装配链接检查：清单里每个插件都必须能被 Node 真正解析到。
 *
 * 为什么需要它：包从一个目录挪到另一个目录时，pnpm 的 workspace 链接不会自动更新；
 * 服务会以「Cannot find package」启动失败，而 check-config 只查目录存在、查不出链接断了。
 * 2026-11-12 就是这么把生产搞挂的（qm-review 从 experimental/ 搬到 packages/ 后没重跑 install）。
 *
 * 用法：node scripts/check-links.mjs [--config qingmei.prod.yml]
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const codeRoot = path.resolve(import.meta.dirname, '..')
const requireFromServer = createRequire(path.join(codeRoot, 'apps', 'server', 'package.json'))
const { load: loadYaml } = requireFromServer('js-yaml')

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const configArg = args.indexOf('--config')
const configPath = path.resolve(REPO_ROOT, configArg >= 0 ? args[configArg + 1] : 'qingmei.yml')

const entries = loadYaml(readFileSync(configPath, 'utf8'))
if (!Array.isArray(entries)) throw new Error(`${configPath} 顶层必须是数组`)

const failures = []
for (const entry of entries) {
  const name = entry?.name
  if (typeof name !== 'string' || !name.startsWith('@qingmei/')) continue
  try {
    requireFromServer.resolve(name)
  } catch (error) {
    failures.push({ name, error: error instanceof Error ? error.message.split('\n')[0] : String(error) })
  }
}

if (failures.length > 0) {
  console.error(`✘ ${failures.length} 个插件解析不到（链接断了？先跑 pnpm install）：`)
  for (const item of failures) console.error(`   - ${item.name}：${item.error}`)
  process.exitCode = 1
} else {
  console.log(`✔ ${entries.length} 项清单里所有 @qingmei 插件都能解析`)
}


