/**
 * 本机 worker 配置（纯 Node，便于测试）。
 * 不再写任何 MCP 配置：主链路是 worker → ACP。
 */
const { mkdirSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function writeWorkerConfig({ settings, home = os.homedir(), hostname = os.hostname() }) {
  if (!settings?.serverUrl) return { ok: false, error: '请先填写服务器地址' }
  if (!settings?.token) return { ok: false, error: '请先填写访问令牌' }
  const workerDir = path.join(home, '.qingmei')
  mkdirSync(workerDir, { recursive: true })
  const config = {
    server: settings.serverUrl.replace(/\/+$/, ''),
    token: settings.token,
    name: `${hostname} (Windows)`,
    deviceId: `dev-${hostname.replace(/[^a-zA-Z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
    dshCommand: 'dsh',
    localPort: 7431,
  }
  const file = path.join(workerDir, 'worker.json')
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
  return { ok: true, message: `已写入 ${file}` }
}

module.exports = { writeWorkerConfig }
