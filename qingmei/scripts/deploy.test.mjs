/**
 * 部署脚本的纯逻辑测试：哪些路径不能进部署包。
 * 打包排除写错一次，就是把 node_modules 或 300MB 安装包发上去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldExclude } from './deploy.mjs'

test('shouldExclude：运行时数据与依赖不进包', () => {
  assert.equal(shouldExclude('node_modules/cordis/package.json'), true)
  assert.equal(shouldExclude('data/qm.db'), true)
  assert.equal(shouldExclude('.git/config'), true)
  assert.equal(shouldExclude('config-snapshots/x.yml'), true)
  assert.equal(shouldExclude('updates/desktop/latest.json'), true)
})

test('shouldExclude：构建产物与移动端副本不进包', () => {
  assert.equal(shouldExclude('apps/desktop/dist/Qingmei-Setup-0.1.4.exe'), true)
  assert.equal(shouldExclude('apps/mobile/www/app.js'), true)
  assert.equal(shouldExclude('apps/mobile/android/build/x'), true)
})

test('shouldExclude：源码与前端产物要进包', () => {
  assert.equal(shouldExclude('packages/qm-agent/src/index.ts'), false)
  assert.equal(shouldExclude('apps/web/dist/index.html'), false)
  assert.equal(shouldExclude('qingmei.prod.yml'), false)
  assert.equal(shouldExclude('scripts/supervisor.mjs'), false)
})
