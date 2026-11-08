#!/usr/bin/env node
/**
 * 一次性把历史 qm_task_run.target_json 迁到当前 TaskTarget：
 * - deviceId -> executorId = device:<id>
 * - threadId -> sessionKey
 * - 删除 deviceId/threadId/sessionId/harnessId
 *
 * 只处理 records 表中 name='qm_task_run' 的行。
 */
import { DatabaseSync } from 'node:sqlite'

const dbPath = process.argv[2] ?? 'data/qm.db'
const db = new DatabaseSync(dbPath)
const rows = db.prepare("select id, json from records where name = 'qm_task_run'").all()
const update = db.prepare("update records set json = ? where name = 'qm_task_run' and id = ?")
let changed = 0
for (const row of rows) {
  const record = JSON.parse(row.json)
  if (!record.target_json) continue
  let target
  try {
    target = JSON.parse(record.target_json)
  } catch {
    continue
  }
  if (target.executorId) continue
  const executorId = target.deviceId ? `device:${target.deviceId}` : 'local'
  const next = {
    executorId,
    ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
    ...(target.threadId ? { sessionKey: target.threadId } : {}),
    ...(target.cwd ? { cwd: target.cwd } : {}),
  }
  record.target_json = JSON.stringify(next)
  update.run(JSON.stringify(record), row.id)
  changed += 1
}
db.close()
console.log(`migrated ${changed}/${rows.length} task targets`)
