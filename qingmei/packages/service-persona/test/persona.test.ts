import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as PersonaPlugin from '../src/index.ts'

test('人格包：加载、版本/hash、reload 热更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-persona-'))
  const file = join(dir, 'persona.json')
  writeFileSync(file, JSON.stringify({ name: '青梅', version: '1.0.0', prompt: '第一版人格' }))
  const ctx = new Context()
  const fiber = ctx.plugin(PersonaPlugin, { path: file })
  await fiber
  try {
    const persona = ctx.reflect.get('persona', false) as {
      current: () => { name: string; version: string; prompt: string; hash: string }
      reload: () => Promise<{ version: string }>
    }
    assert.equal(persona.current().prompt, '第一版人格')
    assert.equal(persona.current().version, '1.0.0')
    assert.match(persona.current().hash, /^[a-f0-9]{12}$/)

    writeFileSync(file, JSON.stringify({ name: '青梅', version: '1.1.0', prompt: '第二版人格' }))
    const next = await persona.reload()
    assert.equal(next.version, '1.1.0')
    assert.equal(persona.current().prompt, '第二版人格')
  } finally {
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('人格包：文件缺失/损坏时回退到配置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-persona-'))
  const ctx = new Context()
  const fiber = ctx.plugin(PersonaPlugin, {
    path: join(dir, 'missing.json'),
    name: '备用',
    version: '0.1.0',
    prompt: '备用人格',
  })
  await fiber
  try {
    const persona = ctx.reflect.get('persona', false) as { current: () => { prompt: string; version: string } }
    assert.equal(persona.current().prompt, '备用人格')
    assert.equal(persona.current().version, '0.1.0')
  } finally {
    await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
