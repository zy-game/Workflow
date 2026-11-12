#!/usr/bin/env node
/**
 * 恢复演练：备份 → 用快照覆盖一个临时库 → 逐表比对行数。
 *
 * 只读源库、只写临时目录；不碰运行中的 data/qm.db。
 * 用法：
 *   node scripts/restore-drill.mjs                     # 默认 ./data
 *   node scripts/restore-drill.mjs --data /opt/qingmei/data --out /tmp/qm-drill
 * 退出码 0 = 快照可恢复且行数一致。
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { backupDatabase } from './backup.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

export function tableCounts(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    const rows = db.prepare('SELECT name, COUNT(*) AS n FROM records GROUP BY name ORDER BY name').all()
    return Object.fromEntries(rows.map((row) => [String(row.name), Number(row.n)]))
  } finally {
    db.close()
  }
}

export function compareCounts(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  const diffs = []
  for (const name of names) {
    const expected = before[name] ?? 0
    const actual = after[name] ?? 0
    if (expected !== actual) diffs.push({ name, expected, actual })
  }
  return diffs
}

/** 演练本身：返回 { snapshot, counts, restoredCounts, diffs }。 */
export function drill({ dbPath, outDir }) {
  const snapshot = backupDatabase({ dbPath, outDir, keep: 1 })
  const work = mkdtempSync(path.join(tmpdir(), 'qm-restore-'))
  const restored = path.join(work, 'restored.db')
  try {
    copyFileSync(snapshot, restored)
    const counts = tableCounts(dbPath)
    const restoredCounts = tableCounts(restored)
    return { snapshot, counts, restoredCounts, diffs: compareCounts(counts, restoredCounts) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
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

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = path.resolve(args.data ?? path.join(REPO_ROOT, 'data'))
  const dbPath = dataDir.endsWith('.db') ? dataDir : path.join(dataDir, 'qm.db')
  const outDir = path.resolve(args.out ?? path.join(path.dirname(dbPath), 'backups'))
  const result = drill({ dbPath, outDir })
  console.log(`快照：${result.snapshot}`)
  const names = Object.keys(result.counts)
  const width = Math.max(12, ...names.map((name) => name.length))
  console.log(`${'collection'.padEnd(width)}  源库  恢复后`)
  for (const name of names) {
    console.log(`${name.padEnd(width)}  ${String(result.counts[name]).padStart(4)}  ${String(result.restoredCounts[name] ?? 0).padStart(6)}`)
  }
  if (result.diffs.length > 0) {
    console.error(`✘ 行数不一致：${result.diffs.map((item) => `${item.name} ${item.expected}→${item.actual}`).join(', ')}`)
    process.exitCode = 1
    return
  }
  console.log(`✔ 恢复演练通过：${names.length} 张表、${Object.values(result.counts).reduce((a, b) => a + b, 0)} 行一致`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`[drill] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
