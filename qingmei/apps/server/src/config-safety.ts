/**
 * S2 配置安全：启动前校验 + 快照 + 自动修复。
 *
 * - 合法配置：按内容 hash 去重后落一份快照，最多保留 20 份；
 * - 配置损坏/丢失：回滚到最近一份合法快照，并保留损坏文件为 `.broken-<ts>`；
 * - 快照目录默认在配置文件旁的 `config-snapshots/`。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { load as loadYaml } from 'js-yaml'

const MAX_SNAPSHOTS = 20

export interface ConfigSafetyResult {
  ok: boolean
  repaired: boolean
  snapshot: string | null
  broken: string | null
  error?: string
}

export function isConfigTextValid(source: string): boolean {
  try {
    const document = loadYaml(source)
    return (
      Array.isArray(document) &&
      document.every(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          typeof (item as { name?: unknown }).name === 'string' &&
          String((item as { name: string }).name).trim() !== '',
      )
    )
  } catch {
    return false
  }
}

export function ensureSafeConfig(
  configPath: string,
  snapshotDir = path.join(path.dirname(path.resolve(configPath)), 'config-snapshots'),
): ConfigSafetyResult {
  const resolved = path.resolve(configPath)
  mkdirSync(snapshotDir, { recursive: true })

  let source = ''
  let readError: string | undefined
  try {
    source = readFileSync(resolved, 'utf8')
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error)
  }

  if (readError === undefined && isConfigTextValid(source)) {
    const digest = createHash('sha256').update(source).digest('hex').slice(0, 12)
    const snapshots = listSnapshots(snapshotDir)
    const latest = snapshots[0]
    if (!latest || path.basename(latest).split('-').at(-1) !== `${digest}.yml`) {
      const file = path.join(snapshotDir, `config-${Date.now()}-${digest}.yml`)
      writeFileSync(file, source, 'utf8')
    }
    prune(snapshotDir)
    return { ok: true, repaired: false, snapshot: latest ?? null, broken: null }
  }

  const snapshots = listSnapshots(snapshotDir)
  if (snapshots.length === 0) {
    return {
      ok: false,
      repaired: false,
      snapshot: null,
      broken: null,
      error: readError ?? '配置不是合法 YAML 插件数组，且没有可回滚的快照',
    }
  }

  let broken: string | null = null
  if (existsSync(resolved)) {
    broken = `${resolved}.broken-${Date.now()}`
    renameSync(resolved, broken)
  }
  const restoreFrom = snapshots[0]!
  copyFileSync(restoreFrom, resolved)
  return {
    ok: true,
    repaired: true,
    snapshot: restoreFrom,
    broken,
    error: readError,
  }
}

export function listSnapshots(snapshotDir: string): string[] {
  if (!existsSync(snapshotDir)) return []
  return readdirSync(snapshotDir)
    .filter((name) => /^config-\d+-[a-f0-9]{12}\.yml$/.test(name))
    .sort()
    .reverse()
    .map((name) => path.join(snapshotDir, name))
}

function prune(snapshotDir: string): void {
  const files = listSnapshots(snapshotDir)
  for (const file of files.slice(MAX_SNAPSHOTS)) {
    try {
      rmSync(file)
    } catch {
      // 清理失败不影响启动
    }
  }
}
