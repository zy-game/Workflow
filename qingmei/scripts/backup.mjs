#!/usr/bin/env node
/**
 * 数据备份与恢复。
 *
 * 青梅的全部资产在一个 SQLite 文件里（默认 ./data/qm.db）：历史、记忆、任务账本、
 * 审批、审计。部署与升级会动代码，不该动它；这个脚本负责在动代码之前留一份快照。
 *
 * 用法：
 *   node scripts/backup.mjs                       # 备份到 <data>/backups，保留最近 7 份
 *   node scripts/backup.mjs --keep 14             # 保留 14 份
 *   node scripts/backup.mjs --out D:/qm-backups   # 换目录（建议放到另一块盘）
 *   node scripts/backup.mjs --restore <file>      # 用快照覆盖当前库（先把现库另存一份）
 *
 * 用 SQLite 的 VACUUM INTO 做快照：在线、一致性读，不需要停服务。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_KEEP = 7
const SNAPSHOT = /^qm-(\d{8}-\d{6})(-\d+)?\.db$/

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    if (key === '--keep' || key === '--data' || key === '--out' || key === '--restore' || key === '--remote') {
      args[key.slice(2)] = argv[i + 1]
      i += 1
    }
  }
  return args
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function listSnapshots(outDir) {
  if (!existsSync(outDir)) return []
  return readdirSync(outDir)
    .filter((name) => SNAPSHOT.test(name))
    .sort()
}

/** 备份一次；返回快照路径。库不存在时抛错，避免生成空备份。 */
export function backupDatabase({ dbPath, outDir, keep = DEFAULT_KEEP }) {
  if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`)
  mkdirSync(outDir, { recursive: true })
  const target = path.join(outDir, `qm-${stamp()}.db`)
  // VACUUM INTO 要求目标文件不存在；同一秒重复备份时换个后缀
  const file = existsSync(target) ? path.join(outDir, `qm-${stamp()}-${Date.now() % 1000}.db`) : target
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
  const check = new DatabaseSync(file)
  try {
    const row = check.prepare('PRAGMA integrity_check').get()
    const verdict = row ? Object.values(row)[0] : undefined
    if (String(verdict).toLowerCase() !== 'ok') throw new Error(`快照完整性检查失败：${String(verdict)}`)
  } finally {
    check.close()
  }
  prune(outDir, keep, path.basename(file))
  return file
}

/** 只保留最近 keep 份（含刚生成的那份）；keep<=0 表示不清理。 */
export function prune(outDir, keep, keepName) {
  if (!Number.isFinite(keep) || keep <= 0) return []
  const snapshots = listSnapshots(outDir).filter((name) => name !== keepName)
  const remove = snapshots.slice(0, Math.max(0, snapshots.length - (keep - 1)))
  for (const name of remove) rmSync(path.join(outDir, name), { force: true })
  return remove
}

/** 覆盖前先把现库另存一份，避免 restore 变成单向操作。 */
export function restoreDatabase({ dbPath, from, outDir }) {
  if (!existsSync(from)) throw new Error(`快照不存在：${from}`)
  const safety = existsSync(dbPath) ? backupDatabase({ dbPath, outDir, keep: 0 }) : null
  copyFileSync(from, dbPath)
  return { restoredFrom: from, previous: safety }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = path.resolve(args.data ?? path.join(REPO_ROOT, 'data'))
  const dbPath = dataDir.endsWith('.db') ? dataDir : path.join(dataDir, 'qm.db')
  const outDir = path.resolve(args.out ?? path.join(path.dirname(dbPath), 'backups'))

  if (args.restore) {
    const result = restoreDatabase({ dbPath, from: path.resolve(args.restore), outDir })
    console.log(`✔ 已恢复：${result.restoredFrom}`)
    if (result.previous) console.log(`  恢复前的库另存为：${result.previous}`)
    console.log('  重启服务后生效；确认无误再删旧的 data/backups。')
    return
  }

  const file = backupDatabase({ dbPath, outDir, keep: Number(args.keep ?? DEFAULT_KEEP) })
  const size = Math.round(statSync(file).size / 1024)
  console.log(`✔ 快照：${file}（${size} KB）`)
  console.log(`  保留：${listSnapshots(outDir).length} 份，目录 ${outDir}`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`[backup] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}


