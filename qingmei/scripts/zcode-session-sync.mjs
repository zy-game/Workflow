#!/usr/bin/env node
/**
 * ZCode 会话同步补偿。
 *
 * ZCode GUI 的 Stop hook 在 headless/ACP 路径不触发；会话事实都在
 * ~/.zcode/cli/db/db.sqlite 的 session/message/part 表里。
 * 本脚本增量读取最近会话，转换 turns 后送本机 worker /session/ingest。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const home = homedir()
const dbPath = process.env.ZCODE_DB || path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')
const statePath = path.join(home, '.qingmei', 'zcode-sync.json')
const endpoint = process.env.QM_WORKER_INGEST || 'http://127.0.0.1:7431/session/ingest'

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return {}
  }
}

function stripUserPrefix(text) {
  const marker = text.indexOf('【用户】')
  return marker >= 0 ? text.slice(marker + '【用户】'.length).trim() : text.trim()
}

function turnsOf(db, sessionId) {
  const rows = db.prepare(`
    SELECT m.id AS message_id, m.data AS message_data, p.data AS part_data
    FROM message m LEFT JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ?
    ORDER BY m.sequence, p.sequence
  `).all(sessionId)
  const grouped = new Map()
  for (const row of rows) {
    let message
    try {
      message = JSON.parse(row.message_data)
    } catch {
      continue
    }
    const role = message.role === 'user' ? 'user' : 'assistant'
    let part
    try {
      part = row.part_data ? JSON.parse(row.part_data) : null
    } catch {
      part = null
    }
    if (!part || part.type !== 'text' || typeof part.text !== 'string') continue
    const current = grouped.get(row.message_id) ?? { role, text: '' }
    current.text += part.text
    grouped.set(row.message_id, current)
  }
  return [...grouped.values()]
    .map((turn) => ({
      role: turn.role,
      text: (turn.role === 'user' ? stripUserPrefix(turn.text) : turn.text).slice(0, 5000),
    }))
    .filter((turn) => turn.text)
    .slice(-100)
}

async function syncOnce() {
  if (!existsSync(dbPath)) {
    console.log('[zcode-sync] 找不到 ZCode 数据库')
    return
  }
  const state = readState()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  let synced = 0
  try {
    const sessions = db.prepare('SELECT id,title,directory,time_updated FROM session ORDER BY time_updated DESC LIMIT 5').all()
    for (const session of sessions) {
      if (state[session.id] && state[session.id] >= session.time_updated) continue
      const turns = turnsOf(db, session.id)
      if (turns.length === 0) continue
      const summary = turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.text).join('\n').slice(0, 12000)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, cwd: session.directory, summary, turns, facts: [], lessons: [] }),
      }).catch(() => null)
      if (!response?.ok) break
      state[session.id] = session.time_updated
      writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
      synced += 1
    }
  } finally {
    db.close()
  }
  mkdirSync(path.dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
  console.log(`[zcode-sync] 同步 ${synced} 个会话`)
}

const watch = process.argv.includes('--watch')
await syncOnce()
if (watch) {
  setInterval(() => void syncOnce(), 30_000)
}
