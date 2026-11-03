#!/usr/bin/env node
/**
 * 部署 supervisor（S1 的最小版，scripts 层，不是常驻服务）。
 *
 * 流程：备份当前 app 目录 → 解包新版本 → 重启服务 → 轮询 healthz。
 * 不健康就把备份换回去、再重启一次，并返回失败。
 *
 * 用法（服务器上）：
 *   node scripts/supervisor.mjs \
 *     --app /opt/qingmei --backup /opt/qingmei.prev \
 *     --tarball /tmp/q.tgz --service qingmei \
 *     --health http://127.0.0.1:7410/healthz --timeout 60000
 *
 * 注意：它依赖 systemd 与 root 权限；不是“不可变外壳”，也不做版本目录管理。
 */
import { cp, rm, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const SKIP_SEGMENTS = new Set(['data', 'node_modules', '.git', 'dist'])

export async function copyTree(from, to, { skip = SKIP_SEGMENTS } = {}) {
  await rm(to, { recursive: true, force: true })
  await mergeTree(from, to, { skip })
}

/** 覆盖式合并：保留目标里被 skip 的目录（data / node_modules） */
export async function mergeTree(from, to, { skip = SKIP_SEGMENTS } = {}) {
  await mkdir(to, { recursive: true })
  await cp(from, to, {
    recursive: true,
    force: true,
    filter: (source) => {
      const relative = path.relative(from, source)
      if (!relative) return true
      return !relative.split(path.sep).some((segment) => skip.has(segment))
    },
  })
}

export async function waitHealthy(health, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await health()) return true
    } catch {
      // 继续等
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

/**
 * 部署并回滚。extract/restart/health 都注入，便于测试与换实现。
 */
export async function pruneHistory(historyDir, keep = 3) {
  const names = (await readdir(historyDir)).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a))
  for (const name of names.slice(keep)) {
    await rm(path.join(historyDir, name), { recursive: true, force: true }).catch(() => undefined)
  }
}
export async function deployWithRollback({
  appDir,
  backupDir,
  extract,
  restart,
  health,
  timeoutMs = 60_000,
  historyDir = null,
  release = false,
  log = () => {},
}) {
  await copyTree(appDir, backupDir)
  await extract()
  await restart()
  if (await waitHealthy(health, timeoutMs)) {
    log('新版本健康')
    if (historyDir) {
      await copyTree(backupDir, path.join(historyDir, String(Date.now())))
      await pruneHistory(historyDir, 3)
    }
    if (release) {
      try {
        const script = path.join(appDir, 'scripts', 'releases.mjs')
        if (existsSync(script)) {
          execFileSync(process.execPath, [script, 'create', '--app', appDir], { stdio: 'inherit' })
          log('已创建 release 快照')
        }
      } catch (error) {
        log('release 快照失败（不影响部署）：' + String(error))
      }
    }
    return { ok: true, rolledBack: false, healthy: true }
  }

  log('新版本不健康，开始回滚')
  await mergeTree(backupDir, appDir)
  await restart()
  const healthy = await waitHealthy(health, timeoutMs)
  log(healthy ? '已回滚到旧版本' : '回滚后仍不健康，需要人工介入')
  return { ok: false, rolledBack: true, healthy }
}

/** 把指定历史版本覆盖回 app 并重启；用于“回滚到任一版本” */
export async function rollbackTo({ appDir, fromDir, restart, health, timeoutMs = 60_000, log = () => {} }) {
  await mergeTree(fromDir, appDir)
  await restart()
  const healthy = await waitHealthy(health, timeoutMs)
  log(healthy ? `已回滚到 ${fromDir}` : '回滚后仍不健康，需要人工介入')
  return { ok: healthy, healthy, from: fromDir }
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const appDir = path.resolve(args.app ?? '/opt/qingmei')
  const backupDir = path.resolve(args.backup ?? `${appDir}.prev`)
  const tarball = path.resolve(args.tarball ?? '/tmp/q.tgz')
  const service = args.service ?? 'qingmei'
  const healthUrl = args.health ?? 'http://127.0.0.1:7410/healthz'
  const timeoutMs = Number(args.timeout ?? 60_000)
  const historyDir = args.history ? path.resolve(args.history) : path.join(path.dirname(appDir), 'qingmei-history')
  const rollbackToDir = args['rollback-to'] ? path.resolve(args['rollback-to']) : null

  if (!existsSync(appDir)) throw new Error(`app 目录不存在：${appDir}`)

  const restart = async () => {
    execFileSync('systemctl', ['restart', service], { stdio: 'inherit' })
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  const health = async () => {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) return false
    const body = await response.json()
    return body.ok !== false
  }

  if (rollbackToDir) {
    const result = await rollbackTo({
      appDir,
      fromDir: rollbackToDir,
      restart,
      health,
      timeoutMs,
      log: (message) => console.log(`[supervisor] ${message}`),
    })
    if (!result.healthy) process.exitCode = 1
    return
  }

  if (!existsSync(tarball)) throw new Error(`tarball 不存在：${tarball}`)

  const result = await deployWithRollback({
    appDir,
    backupDir,
    extract: async () => {
      execFileSync('tar', ['-xzf', tarball, '-C', appDir], { stdio: 'inherit' })
      execFileSync('cp', ['qingmei.prod.yml', 'qingmei.yml'], { cwd: appDir, stdio: 'inherit' })
      if (args.install) {
        execFileSync('sh', ['-c', args.install], { cwd: appDir, stdio: 'inherit', env: process.env })
      }
    },
    restart,
    health,
    timeoutMs,
    historyDir,
    release: args.releases !== false,
    log: (message) => console.log(`[supervisor] ${message}`),
  })

  if (!result.healthy) process.exitCode = 1
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[supervisor] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
