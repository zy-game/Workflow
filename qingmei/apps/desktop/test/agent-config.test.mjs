import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import agentConfig from '../electron/agent-config.cjs'

const settings = {
  serverUrl: 'https://qingmei.test:8710',
  token: 'gateway-token',
  mcpToken: 'mcp-token',
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'qm-agent-config-'))
}

test('ZCode：写入 mcp.servers，不破坏已有配置', () => {
  const home = tempHome()
  const file = join(home, '.zcode', 'cli', 'config.json')
  assert.equal(agentConfig.setupAgent({ target: 'zcode', settings, home }).ok, true)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(parsed.mcp.servers.qingmei.type, 'http')
  assert.equal(parsed.mcp.servers.qingmei.url, 'https://qingmei.test:8710/mcp')
  assert.equal(parsed.mcp.servers.qingmei.headers.Authorization, 'Bearer mcp-token')
})

test('DSH + .agents：都写入同一个 MCP 地址', () => {
  const home = tempHome()
  assert.equal(agentConfig.setupAgent({ target: 'dsh', settings, home }).ok, true)
  const yaml = readFileSync(join(home, '.dsh', 'mcp.servers.yml'), 'utf8')
  assert.match(yaml, /url: https:\/\/qingmei\.test:8710\/mcp/)
  const agents = JSON.parse(readFileSync(join(home, '.agents', 'mcp.json'), 'utf8'))
  assert.equal(agents.mcpServers.qingmei.url, 'https://qingmei.test:8710/mcp')
})

test('Worker：写入本机 ACP 配置', () => {
  const home = tempHome()
  assert.equal(agentConfig.setupAgent({ target: 'worker', settings, home, hostname: 'MY-PC' }).ok, true)
  const worker = JSON.parse(readFileSync(join(home, '.qingmei', 'worker.json'), 'utf8'))
  assert.equal(worker.server, 'https://qingmei.test:8710')
  assert.equal(worker.token, 'gateway-token')
  assert.equal(worker.dshCommand, 'dsh')
  assert.match(worker.deviceId, /^dev-MY-PC-/)
})

test('缺少 MCP Token 时拒绝写配置', () => {
  const home = tempHome()
  const result = agentConfig.setupAgent({ target: 'zcode', settings: { ...settings, mcpToken: '' }, home })
  assert.equal(result.ok, false)
})
