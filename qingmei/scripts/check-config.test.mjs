/**
 * 清单门禁自身的测试。
 *
 * 最关键的一条是「仓库自带的两个清单都能解析」：生产清单曾经引用 19 个已删除的包，
 * 直到部署时 import 失败才暴露；这条用例把它提前到 node --test。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { checkEntries, checkFile, envRefs, workspacePackages } from './check-config.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

test('checkEntries：引用不存在的包要指到具体条目', () => {
  const errors = checkEntries(
    [{ name: '@qingmei/qm-agent' }, { name: '@qingmei/service-store' }],
    new Map([['@qingmei/qm-agent', 'packages/qm-agent']]),
  )
  assert.deepEqual(errors, ['第 2 项 引用的包不存在：@qingmei/service-store（工作区没有同名包）'])
})

test('checkEntries：同名插件重复装配要报错', () => {
  const known = new Map([['@qingmei/qm-agent', 'packages/qm-agent']])
  const errors = checkEntries([{ name: '@qingmei/qm-agent' }, { name: '@qingmei/qm-agent' }], known)
  assert.deepEqual(errors, ['第 2 项 与第 1 项重复：@qingmei/qm-agent'])
})

test('workspacePackages：只认有 package.json 的目录', () => {
  const known = workspacePackages(REPO_ROOT)
  assert.equal(known.get('@qingmei/qm-agent'), 'packages/qm-agent')
  assert.equal(known.get('@qingmei/qm-review'), 'packages/qm-review')
  assert.equal(known.has('@qingmei/service-store'), false)
})

test('仓库自带的 qingmei.yml 全部可解析', () => {
  const result = checkFile(path.join(REPO_ROOT, 'qingmei.yml'))
  assert.deepEqual(result.errors, [])
  assert.equal(result.count, 26)
})

test('仓库自带的 qingmei.prod.yml 全部可解析', () => {
  const result = checkFile(path.join(REPO_ROOT, 'qingmei.prod.yml'))
  assert.deepEqual(result.errors, [])
})

test('envRefs：嵌套收集 { $env } 引用', () => {
  const refs = envRefs([
    { name: 'a', config: { token: { $env: 'QM_TOKEN' }, nested: [{ $env: 'QM_LLM_KEY' }] } },
    { name: 'b', config: { plain: 'x' } },
  ])
  assert.deepEqual(refs, ['QM_LLM_KEY', 'QM_TOKEN'])
})














