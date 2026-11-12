#!/usr/bin/env node
/**
 * Cordis 架构基线检查。
 *
 * 默认只报告；--strict 时任何 ctx.reflect.get 都视为违规。
 * 这不是替代类型检查，只是防止“已经 inject 却绕过服务契约”继续扩散。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve('packages')
const strict = process.argv.includes('--strict')
const violations = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry)
    const stat = statSync(file)
    if (stat.isDirectory()) {
      if (entry === 'test' || entry === 'node_modules' || entry === 'dist') continue
      walk(file)
      continue
    }
    if (!file.endsWith('.ts')) continue
    const text = readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    lines.forEach((line, index) => {
      const collection = /store\.collection(?:<[^>]*>)?\('([^']+)'\)/.exec(line)
    if (collection) {
      const owner = owners[collection[1]]
      const pkg = path.relative(root, file).split(path.sep)[0]
      if (owner && owner !== pkg) crossCollections.push({ pkg, collection: collection[1], owner })
    }
    if (line.includes('ctx.reflect.get(')) {
        violations.push({ file: path.relative(root, file), line: index + 1, text: line.trim() })
      }
    })
  }
}

const owners = {
  qm_message: 'qm-history',
  qm_turn: 'qm-history',
  qm_channel_target: 'qm-approval',
  qm_approval: 'qm-approval',
  qm_task_run: 'qm-task',
  qm_incident: 'qm-autonomy',
  qm_memory_candidate: 'qm-distill',
  qm_skill_draft: 'qm-evolve',
  qm_distill_quota: 'qm-distill',
  qm_session_digest: 'qm-device',
  qm_commitment: 'qm-autonomy',
  qm_opening: 'qm-autonomy',
  qm_opening_topic: 'qm-autonomy',
  qm_content_item: 'qm-content',
  qm_content_variant: 'qm-content',
  qm_content_action: 'qm-content',
  qm_review_state: 'qm-review',
  qm_review_card: 'qm-review',
  qm_review_proposal: 'qm-review',
}
const crossCollections = []
walk(root)

const byPackage = new Map()
for (const violation of violations) {
  const name = violation.file.split(path.sep)[0]
  byPackage.set(name, (byPackage.get(name) ?? 0) + 1)
}

console.log(`Cordis 架构报告：${violations.length} 处 ctx.reflect.get`)
for (const [name, count] of [...byPackage.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name}: ${count}`)
}

console.log(`collection 越界：${crossCollections.length} 处`)
for (const item of crossCollections) {
  console.log(`  ${item.pkg} → ${item.collection}（owner ${item.owner}）`)
}

if (violations.length > 0) {
  console.log('\n前 30 条：')
  for (const violation of violations.slice(0, 30)) {
    console.log(`  ${violation.file}:${violation.line}  ${violation.text}`)
  }
}

if (strict && (violations.length > 0 || crossCollections.length > 0)) {
  console.error('\n严格模式：存在绕过 inject 的服务访问或跨插件 collection 访问')
  process.exit(1)
}


