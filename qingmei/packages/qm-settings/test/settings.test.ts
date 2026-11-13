import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import * as storePlugin from '@qingmei/provider-store-sqlite'
import * as gatewayPlugin from '@qingmei/service-gateway'
import * as settingsPlugin from '../src/index.ts'

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-settings-'))
  const ctx = new Context()
  const storeFiber = ctx.plugin(storePlugin, { path: join(dir, 'settings.db') })
  await storeFiber
  const gatewayFiber = ctx.plugin(gatewayPlugin)
  await gatewayFiber
  const settingsFiber = ctx.plugin(settingsPlugin)
  await settingsFiber
  return {
    ctx,
    store: ctx.reflect.get('store', false),
    async call(method: string, path: string, body?: unknown) {
      const response = { statusCode: 0, body: null as unknown }
      const res = {
        status(code: number) {
          response.statusCode = code
          return res
        },
        send(payload: unknown) {
          response.body = payload
          return res
        },
        json(payload: unknown) {
          response.body = payload
          return res
        },
      }
      await ctx.gateway.dispatch({ method, path, query: {}, headers: {}, body } as never, res as never)
      return response
    },
    async dispose() {
      await settingsFiber.dispose()
      await gatewayFiber.dispose()
      await storeFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('设置：密钥密文落库、列表只回掩码、保存写回 env', async () => {
  process.env.QM_TOKEN = 'test-token'
  delete process.env.QM_LLM_KEY
  const h = await boot()
  try {
    const saved = await h.call('PUT', '/api/v1/settings', {
      values: { QM_LLM_KEY: 'sk-1234567890', QM_LLM_BASE_URL: 'https://api.example.com' },
    })
    assert.equal(saved.statusCode, 200)
    assert.equal(process.env.QM_LLM_KEY, 'sk-1234567890')

    const rows = await (h.store as { collection: (name: string) => { find: () => Promise<Array<{ id: string; value: string }>> } }).collection('qm_setting').find()
    const keyRow = rows.find((row) => row.id === 'QM_LLM_KEY')
    assert.ok(keyRow)
    assert.ok(!keyRow.value.includes('sk-1234567890'), '库里不能出现明文')

    const list = await h.call('GET', '/api/v1/settings')
    const items = (list.body as { items: Array<{ key: string; masked: string; value: string; source: string }> }).items
    const secret = items.find((item) => item.key === 'QM_LLM_KEY')
    assert.equal(secret?.value, '')
    assert.match(secret?.masked ?? '', /7890$/)
    assert.equal(secret?.source, 'settings')
    const plain = items.find((item) => item.key === 'QM_LLM_BASE_URL')
    assert.equal(plain?.value, 'https://api.example.com')
  } finally {
    await h.dispose()
    delete process.env.QM_LLM_KEY
    delete process.env.QM_TOKEN
  }
})

test('设置：清空一项会回退到环境变量默认值', async () => {
  process.env.QM_TOKEN = 'test-token'
  process.env.QM_EMBEDDING_MODEL = 'env-model'
  const h = await boot()
  try {
    await h.call('PUT', '/api/v1/settings', { values: { QM_EMBEDDING_MODEL: 'setting-model' } })
    assert.equal(process.env.QM_EMBEDDING_MODEL, 'setting-model')
    await h.call('PUT', '/api/v1/settings', { values: { QM_EMBEDDING_MODEL: '' } })
    assert.equal(process.env.QM_EMBEDDING_MODEL, 'env-model')
  } finally {
    await h.dispose()
    delete process.env.QM_EMBEDDING_MODEL
    delete process.env.QM_TOKEN
  }
})
