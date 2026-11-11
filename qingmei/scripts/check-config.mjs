#!/usr/bin/env node
/**
 * 清单门禁：清单里每个插件名都必须对应工作区里真实存在的包。
 *
 * 为什么需要它：生产清单曾经引用 19 个已删除的包（service-store、qm-thread、
 * provider-llm-openai…），直到部署时组合根动态 import 才失败；那时服务已经停了。
 * 这条检查只看名字，不起服务、不碰数据库，可以放在提交与部署之前。
 *
 * 用法：
 *   node scripts/check-config.mjs                     # 检查 qingmei.yml 与 qingmei.prod.yml
 *   node scripts/check-config.mjs qingmei.prod.yml    # 只检查指定文件
 *   node scripts/check-config.mjs --env               # 额外要求 { $env: 'X' } 引用的变量已设置
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_MANIFESTS = ['qingmei.yml', 'qingmei.prod.yml']
const WORKSPACE_GROUPS = ['packages', 'experimental']

const requireFromServer = createRequire(path.join(REPO_ROOT, 'apps', 'server', 'package.json'))
const { load: loadYaml } = requireFromServer('js-yaml')

/** 工作区里的 包名 → 目录（相对仓库根）。只认有 package.json 的目录。 */
export function workspacePackages(repoRoot = REPO_ROOT) {
  const found = new Map()
  for (const group of WORKSPACE_GROUPS) {
    const parent = path.join(repoRoot, group)
    if (!existsSync(parent)) continue
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = path.join(parent, entry.name, 'package.json')
      if (!existsSync(manifest)) continue
      let parsed
      try {
        parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      } catch {
        continue
      }
      if (typeof parsed.name === 'string' && parsed.name !== '') found.set(parsed.name, `${group}/${entry.name}`)
    }
  }
  return found
}

/** 读清单；只做结构解析，不解析 { $env }（检查不该依赖密钥）。 */
export function readEntries(file) {
  const document = loadYaml(readFileSync(file, 'utf8'))
  if (!Array.isArray(document)) throw new Error(`${file} 的顶层必须是数组`)
  return document.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${file} 第 ${index + 1} 项 必须是对象`)
    }
    if (typeof item.name !== 'string' || item.name.trim() === '') {
      throw new Error(`${file} 第 ${index + 1} 项 缺少非空字符串 name`)
    }
    return { name: item.name, config: item.config }
  })
}

/** 收集清单里所有 { $env: 'X' } 引用。部署前用它核对 EnvironmentFile 是否齐全。 */
export function envRefs(entries) {
  const names = new Set()
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const env = value.$env
    if (typeof env === 'string' && env !== '') {
      names.add(env)
      return
    }
    for (const item of Object.values(value)) walk(item)
  }
  for (const entry of entries) walk(entry.config)
  return [...names].sort()
}

/**
 * 纯函数：给定条目与可用包名，返回问题列表。
 * 重复项按「同名第二次出现」报，避免一个包被挂两次导致服务与路由重复注册。
 */
export function checkEntries(entries, known) {
  const errors = []
  const seen = new Map()
  entries.forEach((entry, index) => {
    const at = `第 ${index + 1} 项`
    if (seen.has(entry.name)) {
      errors.push(`${at} 与第 ${seen.get(entry.name)} 项重复：${entry.name}`)
      return
    }
    seen.set(entry.name, index + 1)
    if (!known.has(entry.name)) {
      errors.push(`${at} 引用的包不存在：${entry.name}（工作区没有同名包）`)
    }
  })
  return errors
}

/** 检查一个清单文件；返回 { file, count, errors, env }。 */
export function checkFile(file, { known = workspacePackages() } = {}) {
  const entries = readEntries(file)
  return {
    file,
    count: entries.length,
    errors: checkEntries(entries, known),
    env: envRefs(entries),
  }
}

function main() {
  const args = process.argv.slice(2)
  const requireEnv = args.includes('--env')
  const files = args.filter((arg) => !arg.startsWith('--'))
  const targets = (files.length > 0 ? files : DEFAULT_MANIFESTS).map((file) =>
    path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file),
  )

  const known = workspacePackages()
  let failed = false
  const allEnv = new Set()

  for (const file of targets) {
    const label = path.relative(REPO_ROOT, file) || file
    let result
    try {
      result = checkFile(file, { known })
    } catch (error) {
      failed = true
      console.error(`✘ ${label}：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const name of result.env) allEnv.add(name)
    if (result.errors.length === 0) {
      console.log(`✔ ${label}：${result.count} 项，全部可解析`)
      continue
    }
    failed = true
    console.error(`✘ ${label}：${result.errors.length} 处问题（共 ${result.count} 项）`)
    for (const message of result.errors) console.error(`   - ${message}`)
  }

  if (requireEnv) {
    const missing = [...allEnv].filter((name) => !process.env[name])
    allEnv.clear()
    if (missing.length > 0) {
      failed = true
      console.error(`✘ 缺少环境变量：${missing.join(', ')}`)
    } else {
      console.log('✔ 环境变量齐全')
    }
  }

  process.exit(failed ? 1 : 0)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) main()
