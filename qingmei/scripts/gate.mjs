#!/usr/bin/env node
/**
 * 青梅成熟度门禁。
 *
 * 默认执行：
 *   1. 架构检查
 *   2. 神经元记忆类型检查
 *   3. 全量单元/集成测试
 * 可选：
 *   --with-smoke 额外启动 smoke（需要本机可启动 server）
 *
 * 这是最小门禁，不伪造 tsc：仓库当前没有可用的类型检查脚本。
 */
import { spawnSync } from 'node:child_process'

const node = process.execPath
const withSmoke = process.argv.includes('--with-smoke')
const steps = [
  { name: 'architecture', args: ['scripts/check-architecture.mjs', '--strict'] },
  { name: 'typecheck:memory', args: ['node_modules/typescript/bin/tsc', '-p', 'packages/provider-neuron-memory/tsconfig.json'] },
  { name: 'typecheck:autonomy', args: ['node_modules/typescript/bin/tsc', '-p', 'packages/qm-autonomy/tsconfig.json'] },
  { name: 'tests', args: ['--test', '--test-concurrency=1'] },
]
if (withSmoke) steps.push({ name: 'smoke', args: ['scripts/smoke.mjs'] })

let failed = false
for (const step of steps) {
  process.stdout.write(`\n[gate] ${step.name}\n`)
  const result = spawnSync(node, step.args, { stdio: 'inherit' })
  if (result.status !== 0) {
    failed = true
    process.stderr.write(`[gate] ${step.name} FAILED\n`)
    break
  }
  process.stdout.write(`[gate] ${step.name} PASS\n`)
}

if (!withSmoke) process.stdout.write('\n[gate] smoke skipped (use --with-smoke)\n')
process.exit(failed ? 1 : 0)
