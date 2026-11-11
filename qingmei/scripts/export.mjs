#!/usr/bin/env node
/**
 * 数据导出：把账本读成 JSON，用于检查、迁移和"带走自己的数据"。
 *
 * 备份（scripts/backup.mjs）保留的是可恢复的整库快照；导出是给人看的可读副本，
 * 不进恢复链路。默认不导出 secret 敏感度的事实。
 *
 * 用法：
 *   node scripts/export.mjs                          # → data/exports/qm-export-<时间>.json
 *   node scripts/export.mjs --collections qm_mem_fact,qm_task_run
 *   node scripts/export.mjs --include-secret         # 连 secret 事实一起导出
 *   node scripts/export.mjs --all                    # 除消息外全部集合
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
/** 默认导出这几张表；qm_message 可能很大，要全量用 --all */
const DEFAULT_COLLECTIONS = ['qm_mem_fact', 'qm_task_run', 'qm_schedule', 'qm_approval', 'qm_audit']

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function listCollections(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    return db
      .prepare("SELECT DISTINCT name FROM records ORDER BY name")
      .all()
      .map((row) => String(row.name))
  } finally {
    db.close()
  }
}

/** 读集合；secret 事实默认剔除，避免导出文件变成泄密面。 */
export function readCollection(dbPath, name, { includeSecret = false } = {}) {
  const db = new DatabaseSync(dbPath)
  try {
    const rows = db.prepare('SELECT json FROM records WHERE name = ? ORDER BY created_at, id').all(name)
    const items = rows.map((row) => JSON.parse(String(row.json)))
    if (includeSecret) return items
    return items.filter((item) => item?.sensitivity !== 'secret')
  } finally {
    db.close()
  }
}

export function exportDatabase({ dbPath, collections, includeSecret = false }) {
  if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`)
  const available = new Set(listCollections(dbPath))
  const wanted = collections?.length ? collections : DEFAULT_COLLECTIONS
  const picked = wanted.filter((name) => available.has(name))
  const payload = {
    exportedAt: new Date().toISOString(),
    database: dbPath,
    includeSecret,
    collections: {},
    counts: {},
    missing: wanted.filter((name) => !available.has(name)),
  }
  for (const name of picked) {
    const items = readCollection(dbPath, name, { includeSecret })
    payload.collections[name] = items
    payload.counts[name] = items.length
  }
  return payload
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    if (['--data', '--out', '--collections'].includes(key)) {
      args[key.slice(2)] = argv[i + 1]
      i += 1
    } else {
      args[key.slice(2)] = true
    }
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = path.resolve(args.data ?? path.join(REPO_ROOT, 'data'))
  const dbPath = dataDir.endsWith('.db') ? dataDir : path.join(dataDir, 'qm.db')
  const outDir = path.resolve(args.out ?? path.join(path.dirname(dbPath), 'exports'))
  const explicit = typeof args.collections === 'string' ? args.collections.split(',').map((item) => item.trim()).filter(Boolean) : []
  const collections = args.all ? listCollections(dbPath) : explicit

  const payload = exportDatabase({ dbPath, collections, includeSecret: args['include-secret'] === true })
  mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `qm-export-${stamp()}.json`)
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`✔ ${file}`)
  for (const [name, count] of Object.entries(payload.counts)) console.log(`  ${name}: ${count}`)
  if (payload.missing.length > 0) console.log(`  （库里还没有：${payload.missing.join(', ')}）`)
  if (!payload.includeSecret) console.log('  secret 事实未导出；需要时加 --include-secret')
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`[export] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
