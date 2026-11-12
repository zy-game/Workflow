import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import agentConfig from '../electron/agent-config.cjs'

const settings = {
  serverUrl: 'https://qingmei.test:8710',
  token: 'gateway-token',
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'qm-agent-config-'))
}

test('Worker：写入本机 ACP 配置，不写 MCP', () => {
  const home = tempHome()
  assert.equal(agentConfig.writeWorkerConfig({ settings, home, hostname: 'MY-PC' }).ok, true)
  const worker = JSON.parse(readFileSync(join(home, '.qingmei', 'worker.json'), 'utf8'))
  assert.equal(worker.server, 'https://qingmei.test:8710')
  assert.equal(worker.token, 'gateway-token')
  assert.equal(worker.dshCommand, 'dsh')
  assert.equal(worker.mcpUrl, undefined)
  assert.match(worker.deviceId, /^dev-MY-PC-/)
})

test('缺少 token 时拒绝写 Worker 配置', () => {
  const home = tempHome()
  const result = agentConfig.writeWorkerConfig({ settings: { ...settings, token: '' }, home })
  assert.equal(result.ok, false)
})

test('Worker：重复写入保持同一个 deviceId', () => {
  const home = tempHome()
  const first = agentConfig.writeWorkerConfig({ settings, home, hostname: 'MY-PC' })
  const second = agentConfig.writeWorkerConfig({ settings, home, hostname: 'MY-PC' })
  assert.equal(first.deviceId, second.deviceId)
})

test('Worker：从 DSH 工作区状态自动发现工作区', () => {
  const home = tempHome()
  const dshHome = join(home, '.dsh')
  mkdirSync(join(dshHome, 'storages'), { recursive: true })
  writeFileSync(
    join(dshHome, 'storages', 'workspace.json'),
    JSON.stringify({ tables: { workspaces: { a: { path: 'E:\\\\Work\\\\sanguo' }, b: { path: 'E:\\\\Workflow\\\\qingmei' } } } }),
    'utf8',
  )
  const result = agentConfig.writeWorkerConfig({ settings, home, hostname: 'MY-PC', dshHome })
  assert.equal(result.workspaces, 2)
  const worker = JSON.parse(readFileSync(join(home, '.qingmei', 'worker.json'), 'utf8'))
  assert.equal(worker.workspaces.length, 2)
  assert.equal(worker.workspaces[0].title, 'sanguo')
  assert.ok(worker.workspaces.every((item) => item.id.startsWith('ws-')))
})
