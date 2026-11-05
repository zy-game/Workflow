/**
 * 客户端 MCP/ACP 配置写入（纯 Node，便于测试）。
 * 桌面主进程只负责取设置和 home，不在这里拼协议。
 */
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function mcpEndpoint(settings, env = process.env) {
  const base = String(settings.serverUrl || '').replace(/\/+$/, '')
  return env.QM_MCP_URL || `${base}/mcp`
}

function setupAgent({ target, settings, home = os.homedir(), env = process.env, hostname = os.hostname() }) {
  if (!settings?.mcpToken) return { ok: false, error: '请先填写 MCP Token' }
  if (!settings?.serverUrl) return { ok: false, error: '请先填写服务器地址' }
  const url = mcpEndpoint(settings, env)
  const headers = { Authorization: `Bearer ${settings.mcpToken}` }
  const zcodePath = path.join(home, '.zcode', 'cli', 'config.json')
  const dshPath = path.join(home, '.dsh', 'mcp.servers.yml')
  const agentsPath = path.join(home, '.agents', 'mcp.json')
  const server = { type: 'http', url, headers }

  if (target === 'zcode' || target === 'both') {
    let config = {}
    try {
      if (existsSync(zcodePath)) config = JSON.parse(readFileSync(zcodePath, 'utf8'))
    } catch {
      config = {}
    }
    config.mcp = config.mcp && typeof config.mcp === 'object' ? config.mcp : {}
    config.mcp.servers = config.mcp.servers && typeof config.mcp.servers === 'object' ? config.mcp.servers : {}
    config.mcp.servers.qingmei = server
    mkdirSync(path.dirname(zcodePath), { recursive: true })
    writeFileSync(zcodePath, JSON.stringify(config, null, 2), 'utf8')
  }

  if (target === 'dsh' || target === 'both') {
    mkdirSync(path.dirname(dshPath), { recursive: true })
    writeFileSync(
      dshPath,
      ['qingmei:', '  type: http', `  url: ${url}`, '  headers:', `    Authorization: Bearer ${settings.mcpToken}`, ''].join('\n'),
      'utf8',
    )
  }

  if (target === 'zcode' || target === 'dsh' || target === 'both') {
    let agents = { mcpServers: {} }
    try {
      if (existsSync(agentsPath)) agents = JSON.parse(readFileSync(agentsPath, 'utf8'))
    } catch {
      agents = { mcpServers: {} }
    }
    agents.mcpServers = agents.mcpServers && typeof agents.mcpServers === 'object' ? agents.mcpServers : {}
    agents.mcpServers.qingmei = server
    mkdirSync(path.dirname(agentsPath), { recursive: true })
    writeFileSync(agentsPath, JSON.stringify(agents, null, 2), 'utf8')
  }

  if (target === 'worker') {
    const workerPath = path.join(home, '.qingmei', 'worker.json')
    mkdirSync(path.dirname(workerPath), { recursive: true })
    writeFileSync(
      workerPath,
      JSON.stringify(
        {
          server: settings.serverUrl.replace(/\/+$/, ''),
          token: settings.token,
          mcpUrl: url,
          mcpToken: settings.mcpToken,
          name: `${hostname} (Windows)`,
          deviceId: `dev-${hostname.replace(/[^a-zA-Z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
          dshCommand: 'dsh',
        },
        null,
        2,
      ),
      'utf8',
    )
  }

  const names = { zcode: 'ZCode', dsh: 'DSH', both: 'ZCode + DSH', worker: '本机 Worker' }
  return { ok: true, message: `已配置 ${names[target] || target}；MCP ${url}` }
}

module.exports = { mcpEndpoint, setupAgent }
