#!/usr/bin/env node
/**
 * S1 崩溃看门狗（最小版）。
 *
 * 每轮探测 /healthz；连续 N 次失败时，把上一版本（--backup）的代码复制回
 * --app，保留运行数据与配置，然后重启 systemd 服务。
 *
 * 只负责“崩溃后回到上一个可用版本”，不做热替换：代码目录仍由 systemd 的
 * WorkingDirectory 指向。部署时的健康失败回滚仍由 supervisor.mjs 负责。
 */
import { cp, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PRESERVE = new Set(['data', 'node_modules', '.git', 'config-snapshots', 'qingmei.yml', 'tmp'])
const COOLDOWN_MS = 30 * 60 * 1000

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      index += 1
    } else {
      args[key] = true
    }
  }
  return args
}

async function probeHealth(url, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function restoreCode(appDir, backupDir) {
  if (!existsSync(backupDir)) throw new Error(`上一版本不存在：${backupDir}`)
  const entries = await readdir(backupDir, { withFileTypes: true })
  let copied = 0
  for (const entry of entries) {
    if (PRESERVE.has(entry.name)) continue
    await cp(path.join(backupDir, entry.name), path.join(appDir, entry.name), {
      recursive: true,
      force: true,
    })
    copied += 1
  }
  return copied
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return { fails: 0, rolledBackAt: 0 }
  }
}

async function saveState(file, state) {
  await writeFile(file, JSON.stringify(state), 'utf8')
}

/**
 * 执行一轮看门狗。依赖注入方便单测；真实 CLI 用 fetch/systemctl。
 */
export async function watchdogOnce(options) {
  const {
    appDir,
    backupDir,
    healthUrl,
    stateFile,
    threshold = 5,
    cooldownMs = COOLDOWN_MS,
    now = Date.now(),
    probe = probeHealth,
    restart = async () => undefined,
  } = options
  const state = await readState(stateFile)
  const healthy = await probe(healthUrl)
  if (healthy) {
    if (state.fails !== 0) await saveState(stateFile, { ...state, fails: 0 })
    return { action: 'healthy', fails: 0, restored: 0 }
  }

  if (state.rolledBackAt && now - state.rolledBackAt < cooldownMs) {
    await saveState(stateFile, { ...state, fails: 0 })
    return { action: 'cooldown', fails: 0, restored: 0 }
  }

  const fails = Number(state.fails ?? 0) + 1
  if (fails < threshold) {
    await saveState(stateFile, { ...state, fails })
    return { action: 'waiting', fails, restored: 0 }
  }

  const restored = await restoreCode(appDir, backupDir)
  await restart()
  await saveState(stateFile, { fails: 0, rolledBackAt: now })
  return { action: 'rolled-back', fails: 0, restored }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const appDir = path.resolve(args.app ?? '/opt/qingmei')
  const backupDir = path.resolve(args.backup ?? '/opt/qingmei.prev')
  const healthUrl = String(args.health ?? 'http://127.0.0.1:7410/healthz')
  const stateFile = path.resolve(args.state ?? path.join(appDir, 'data', '.watchdog.json'))
  const threshold = Math.max(1, Number(args.threshold ?? 5))
  const result = await watchdogOnce({
    appDir,
    backupDir,
    healthUrl,
    stateFile,
    threshold,
    restart: async () => {
      const { execFile } = await import('node:child_process')
      await new Promise((resolve) => {
        execFile('systemctl', ['restart', 'qingmei'], { timeout: 30_000 }, () => resolve())
      })
    },
  })
  console.log(JSON.stringify(result))
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[watchdog] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
