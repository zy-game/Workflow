#!/usr/bin/env node
/**
 * 看门狗：每 5 分钟检查 healthz；失败时记录、可选重启、可选 webhook 告警。
 *
 * 用法：
 *   node scripts/watchdog.mjs                     # 只检查并记录
 *   node scripts/watchdog.mjs --restart           # 失败时 sudo -n systemctl restart qingmei
 *   node scripts/watchdog.mjs --webhook https://... --url http://127.0.0.1:7410/healthz
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}
const url = argValue('--url', 'http://127.0.0.1:7410/healthz')
const statePath = path.resolve(argValue('--state', 'data/watchdog.json'))
const webhook = argValue('--webhook', process.env.QM_ALERT_WEBHOOK ?? '')
const restart = args.includes('--restart')

async function check() {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json()
  if (body?.ok === false) throw new Error('healthz 返回 ok=false')
  return body
}

function record(payload) {
  mkdirSync(path.dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2))
}

try {
  const body = await check()
  record({ ok: true, url, agent: body?.agent ?? null })
  console.log(`[watchdog] ok ${new Date().toISOString()}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  record({ ok: false, url, error: message })
  console.error(`[watchdog] healthz 失败：${message}`)
  if (restart) {
    try {
      execFileSync('sudo', ['-n', 'systemctl', 'restart', 'qingmei'], { stdio: 'inherit' })
      console.error('[watchdog] 已尝试重启 qingmei')
    } catch (restartError) {
      console.error(`[watchdog] 重启失败：${restartError instanceof Error ? restartError.message : String(restartError)}`)
    }
  }
  if (webhook) {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `青梅 healthz 失败：${message}`, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
  }
  process.exitCode = 1
}
