/**
 * 本机 worker 配置（纯 Node，便于测试）。
 * 不再写任何 MCP 配置：主链路是 worker → ACP。
 *
 * 工作区不做人工打标签：从 DSH 自己的工作区状态（~/.dsh/storages/workspace.json）
 * 自动发现，title 取目录名，id 用路径哈希，桌宠和 worker 共用同一个 deviceId。
 */
const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function workspaceId(workspacePath) {
  return `ws-${createHash('sha1').update(workspacePath).digest('hex').slice(0, 10)}`
}

function readWorkerConfig(home = os.homedir()) {
  try {
    return JSON.parse(readFileSync(path.join(home, '.qingmei', 'worker.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 从 DSH 的 workspace 状态里发现本机工作区（不需要用户手工配置） */
function discoverWorkspaces({ home = os.homedir(), dshHome } = {}) {
  const root = dshHome || process.env.DSH_HOME || path.join(home, '.dsh')
  const file = path.join(root, 'storages', 'workspace.json')
  const found = []
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    for (const item of Object.values(data?.tables?.workspaces ?? {})) {
      const workspacePath = typeof item?.path === 'string' ? item.path.trim() : ''
      if (!workspacePath) continue
      found.push({
        id: workspaceId(workspacePath),
        title: path.basename(workspacePath) || workspacePath,
        path: workspacePath,
      })
    }
  } catch {
    // 没装 DSH 或没有工作区状态：返回空，由上层回退
  }
  const seen = new Set()
  const unique = []
  for (const item of found) {
    const key = item.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  return unique.slice(0, 20)
}

function writeWorkerConfig({ settings, home = os.homedir(), hostname = os.hostname(), dshHome } = {}) {
  if (!settings?.serverUrl) return { ok: false, error: '请先填写服务器地址' }
  if (!settings?.token) return { ok: false, error: '请先填写访问令牌' }
  const workerDir = path.join(home, '.qingmei')
  mkdirSync(workerDir, { recursive: true })
  const existing = readWorkerConfig(home)
  const deviceId =
    existing?.deviceId || `dev-${hostname.replace(/[^a-zA-Z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`
  const workspaces = discoverWorkspaces({ home, dshHome })
  const config = {
    server: settings.serverUrl.replace(/\/+$/, ''),
    token: settings.token,
    name: `${hostname} (Windows)`,
    deviceId,
    dshCommand: 'dsh',
    localPort: 7431,
    workdir: workspaces[0]?.path || existing?.workdir || path.join(home, 'Workflow'),
    ...(workspaces.length > 0 ? { workspaces } : {}),
  }
  const file = path.join(workerDir, 'worker.json')
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
  return {
    ok: true,
    message: `已写入 ${file}（工作区 ${workspaces.length} 个）`,
    deviceId,
    workspaces: workspaces.length,
  }
}

module.exports = { writeWorkerConfig, readWorkerConfig, discoverWorkspaces }
