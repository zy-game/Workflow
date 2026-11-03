import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as skillPlugin from '../src/index.ts'
import type { GatewayRequest, GatewayResponse } from '@qingmei/core'

interface FakeResponse {
  res: GatewayResponse
  read(): { status: number; body: unknown }
}

function fakeResponse(): FakeResponse {
  let status = 0
  let body: unknown
  const res: GatewayResponse = {
    status(code) {
      status = code
      return res
    },
    header() {
      return res
    },
    send(value) {
      body = value
      return res
    },
  }
  return { res, read: () => ({ status, body }) }
}

function writeSkill(root: string, name: string, description: string, body: string): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'skill.json'), JSON.stringify({ description, tools: ['qm_finish_task'] }))
  writeFileSync(join(dir, 'SKILL.md'), body)
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-skill-'))
  const skillsDir = join(dir, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  writeSkill(skillsDir, 'weekly-report', '写周报', '# 周报\n按项目汇总。')
  writeSkill(skillsDir, 'meeting-notes', '会议纪要', '# 纪要\n提炼行动项。')

  const ctx = new Context()
  await ctx.plugin(gatewayPlugin)
  const fiber = ctx.plugin(skillPlugin, { skillsDir })
  await fiber

  return {
    ctx,
    skillsDir,
    async call(req: GatewayRequest) {
      const response = fakeResponse()
      const handled = await ctx.gateway.dispatch(req, response.res)
      return { handled, ...response.read() }
    },
    async dispose() {
      await fiber.dispose()
    },
  }
}

test('插件形态与契约一致：name / inject', () => {
  assert.equal(skillPlugin.name, 'qm-skill')
  assert.deepEqual(skillPlugin.inject, ['gateway'])
})

test('列出与读取技能包', async () => {
  const h = await setup()
  try {
    const listed = await h.call({ method: 'GET', path: '/api/v1/skills', query: {}, headers: {} })
    const items = (listed.body as { items: { name: string; description: string; tools: string[] }[] }).items
    assert.deepEqual(items.map((item) => item.name), ['meeting-notes', 'weekly-report'])
    assert.equal(items[1]?.description, '写周报')
    assert.deepEqual(items[1]?.tools, ['qm_finish_task'])

    const read = await h.call({
      method: 'GET',
      path: '/api/v1/skills/read',
      query: { name: 'weekly-report' },
      headers: {},
    })
    assert.equal(read.status, 200)
    assert.match((read.body as { skill: { body: string } }).skill.body, /按项目汇总/)

    const missing = await h.call({ method: 'GET', path: '/api/v1/skills/read', query: { name: 'nope' }, headers: {} })
    assert.equal(missing.status, 404)
  } finally {
    await h.dispose()
  }
})

test('reload：不重启加载新技能', async () => {
  const h = await setup()
  try {
    writeSkill(h.skillsDir, 'trip-plan', '行程规划', '# 行程\n按天拆。')
    const reloaded = await h.call({ method: 'POST', path: '/api/v1/skills/reload', query: {}, headers: {} })
    const items = (reloaded.body as { items: { name: string }[] }).items
    assert.deepEqual(items.map((item) => item.name), ['meeting-notes', 'trip-plan', 'weekly-report'])
  } finally {
    await h.dispose()
  }
})
