/**
 * 组合根的配置与命令行解析测试。
 *
 * 不启动服务：端到端链路由 scripts/smoke.mjs 覆盖，这里只守住
 * 「清单必须显式、错误必须指到具体条目、参数拼错不能静默用默认值」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CONFIG,
  parseOptions,
  readPluginList,
  stateName,
} from '../src/index.ts'

async function withYaml<T>(source: string, run: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'qm-config-'))
  const file = path.join(dir, 'qingmei.yml')
  try {
    await writeFile(file, source, 'utf8')
    return await run(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('仓库自带的 qingmei.yml：九项插件，端口与数据库路径来自配置', () => {
  const entries = readPluginList(DEFAULT_CONFIG)
  assert.equal(entries.length, 9)
  assert.deepEqual(
    entries.map((entry) => entry.name),
    [
      '@qingmei/service-store',
      '@qingmei/service-llm',
      '@qingmei/service-channel',
      '@qingmei/service-gateway',
      '@qingmei/provider-store-sqlite',
      '@qingmei/provider-llm-echo',
      '@qingmei/qm-agent',
      '@qingmei/channel-web',
      '@qingmei/host-gateway',
    ],
  )
  const store = entries.find((entry) => entry.name === '@qingmei/provider-store-sqlite')
  assert.equal(store?.config?.path, './data/qm.db')
  const host = entries.find((entry) => entry.name === '@qingmei/host-gateway')
  assert.equal(host?.config?.port, 7410)
  assert.equal(host?.config?.webRoot, './apps/web/public')
})

test('readPluginList：顶层必须是数组', async () => {
  await withYaml('name: not-a-list\n', async (file) => {
    assert.throws(() => readPluginList(file), /顶层必须是数组/)
  })
})

test('readPluginList：报错指到具体条目', async () => {
  await withYaml('- name: a\n- config: {}\n', async (file) => {
    assert.throws(() => readPluginList(file), /第 2 项 缺少非空字符串 name/)
  })
})

test('readPluginList：config 必须是对象，允许省略', async () => {
  await withYaml('- name: a\n- name: b\n  config: 1\n', async (file) => {
    assert.throws(() => readPluginList(file), /第 2 项 的 config 必须是对象/)
  })
  await withYaml('- name: a\n', async (file) => {
    assert.deepEqual(readPluginList(file), [{ name: 'a' }])
  })
})

test('parseOptions：解析 --config / --port / --host', () => {
  assert.deepEqual(parseOptions(['--config', 'x.yml', '--port', '18080', '--host', '0.0.0.0']), {
    configPath: 'x.yml',
    port: 18080,
    host: '0.0.0.0',
  })
  assert.deepEqual(parseOptions([]), {})
})

test('parseOptions：拼错、缺值、越界都直接报错', () => {
  assert.throws(() => parseOptions(['--prt', '1']), /未知参数/)
  assert.throws(() => parseOptions(['--port']), /缺少值/)
  assert.throws(() => parseOptions(['--port', '70000']), /0\.\.65535/)
  assert.throws(() => parseOptions(['--port', 'abc']), /0\.\.65535/)
})

test('stateName：cordis fiber 状态可读', () => {
  assert.equal(stateName(0), 'PENDING')
  assert.equal(stateName(2), 'ACTIVE')
  assert.equal(stateName(3), 'FAILED')
  assert.equal(stateName(99), 'UNKNOWN(99)')
})

test('清单里的 { $env } 从环境变量取值，缺失则报错', async () => {
  process.env.QM_TEST_TOKEN = 'secret-token'
  try {
    await withYaml(
      "- name: a\n  config:\n    token: { $env: 'QM_TEST_TOKEN' }\n    nested:\n      - { $env: 'QM_TEST_TOKEN' }\n",
      async (file) => {
        assert.deepEqual(readPluginList(file), [
          { name: 'a', config: { token: 'secret-token', nested: ['secret-token'] } },
        ])
      },
    )
  } finally {
    delete process.env.QM_TEST_TOKEN
  }

  await withYaml("- name: a\n  config:\n    token: { $env: 'QM_NOT_SET_AT_ALL' }\n", async (file) => {
    assert.throws(() => readPluginList(file), /环境变量 QM_NOT_SET_AT_ALL 未设置/)
  })
})

test('清单里的 ${NAME} 做字符串插值，缺失替换为空串', async () => {
  process.env.QM_TEST_HOST = 'example.test'
  try {
    await withYaml("- name: a\n  config:\n    url: 'https://${QM_TEST_HOST}/x'\n", async (file) => {
      assert.deepEqual(readPluginList(file), [
        { name: 'a', config: { url: 'https://example.test/x' } },
      ])
    })
    await withYaml("- name: a\n  config:\n    url: 'https://${QM_UNKNOWN_VAR}/x'\n", async (file) => {
      assert.deepEqual(readPluginList(file), [{ name: 'a', config: { url: 'https:///x' } }])
    })
  } finally {
    delete process.env.QM_TEST_HOST
  }
})
