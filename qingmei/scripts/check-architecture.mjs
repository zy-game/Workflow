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
      if (line.includes('ctx.reflect.get(')) {
        violations.push({ file: path.relative(root, file), line: index + 1, text: line.trim() })
      }
    })
  }
}

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

if (violations.length > 0) {
  console.log('\n前 30 条：')
  for (const violation of violations.slice(0, 30)) {
    console.log(`  ${violation.file}:${violation.line}  ${violation.text}`)
  }
}

if (strict && violations.length > 0) {
  console.error('\n严格模式：存在绕过 inject 的服务访问')
  process.exit(1)
}
