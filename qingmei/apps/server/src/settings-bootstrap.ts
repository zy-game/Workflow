/**
 * 启动最早的一步：把设置页保存的 key 写回 process.env。
 *
 * 必须发生在清单里的 `${ENV}` 解析之前——否则插件构造时读到的还是旧 env。
 * 直接读 SQLite，不经过 store 插件，避免循环依赖。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decryptSecret } from '@qingmei/core'

const ALLOWED = /^QM_(LLM|DSH|MCP|EMBEDDING|FEISHU|QQ)_/

interface Entry {
  name: string
  config?: Record<string, unknown>
}

export function applyStoredSettings(entries: Entry[], cwd = process.cwd()): void {
  const storeEntry = entries.find((entry) => entry.name === '@qingmei/provider-store-sqlite')
  const configured = storeEntry?.config?.path
  const dbPath = path.resolve(cwd, typeof configured === 'string' ? configured : './data/qingmei.db')
  if (!existsSync(dbPath)) return
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare("SELECT json FROM records WHERE name = 'qm_setting'").all() as Array<{ json: string }>
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.json) as { id?: string; value?: string; secret?: boolean }
        const key = parsed.id ?? ''
        if (!key || !ALLOWED.test(key) || typeof parsed.value !== 'string') continue
        const value = parsed.secret ? decryptSecret(parsed.value) : parsed.value
        if (value === null || value === undefined) continue
        process.env[key] = value
      } catch {
        // 坏行跳过，不阻塞启动
      }
    }
  } catch {
    // 数据库还不存在/还没建表时静默跳过
  } finally {
    db?.close()
  }
}
