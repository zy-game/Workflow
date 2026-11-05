/**
 * L3 路径防护（docs/08 §4）。
 *
 * 自动补丁只能改 L2 allowlist；核心层、安全面、发布管线一律拒绝。
 * 手动发布由人执行，不经过这个判断。
 */
const L3_PREFIXES = [
  'packages/core/',
  'packages/service-persona/',
  'packages/host-gateway/',
  'packages/provider-permission-static/',
  'packages/qm-audit/',
  'deploy/',
  'scripts/supervisor.mjs',
  'scripts/watchdog.mjs',
  'scripts/releases.mjs',
  'qingmei.yml',
  'qingmei.prod.yml',
]

export class L3PatchError extends Error {
  constructor(paths) {
    super(`自动补丁触碰 L3 路径，已拒绝：${paths.join(', ')}`)
    this.name = 'L3PatchError'
    this.paths = paths
  }
}

export function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
}

export function isL3Path(value) {
  const path = normalizePath(value)
  return L3_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))
}

export function l3Paths(paths) {
  return [...new Set((Array.isArray(paths) ? paths : []).map(normalizePath).filter(isL3Path))]
}

export function assertPatchScope(paths) {
  const blocked = l3Paths(paths)
  if (blocked.length > 0) throw new L3PatchError(blocked)
  return true
}
