import test from 'node:test'
import assert from 'node:assert/strict'
import layout from '../electron/layout.cjs'

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const secondary = { workArea: { x: 1920, y: -200, width: 2560, height: 1400 } }

test('默认窗口贴主屏右下角', () => {
  const bounds = layout.defaultBoundsIn(primary.workArea, 1)
  assert.equal(bounds.width, 380)
  assert.equal(bounds.height, 560)
  assert.equal(bounds.x, 1516)
  assert.equal(bounds.y, 468)
})

test('DPI 缩放同步窗口尺寸与位置', () => {
  const bounds = layout.defaultBoundsIn(primary.workArea, 1.5)
  assert.equal(bounds.width, 570)
  assert.equal(bounds.height, 840)
  assert.equal(bounds.x, 1326)
  assert.equal(bounds.y, 188)
})

test('副屏负坐标/右侧坐标都算可见', () => {
  assert.equal(layout.isVisibleInDisplays({ x: 2000, y: -100, width: 380, height: 560 }, [primary, secondary]), true)
  assert.equal(layout.isVisibleInDisplays({ x: 0, y: 0, width: 380, height: 560 }, [primary, secondary]), true)
  assert.equal(layout.isVisibleInDisplays({ x: 5000, y: 0, width: 380, height: 560 }, [primary, secondary]), false)
})

test('拖出屏幕边缘时回夹到当前屏', () => {
  const clamped = layout.clampToDisplays({ x: 1800, y: 900, width: 380, height: 560 }, [primary])
  assert.equal(clamped.x, 1540)
  assert.equal(clamped.y, 480)
  const outside = layout.clampToDisplays({ x: 5000, y: 0, width: 380, height: 560 }, [primary])
  assert.equal(outside.x, 5000)
})

test('更新源：环境变量优先，否则生产默认', () => {
  assert.equal(layout.updateFeed({ QM_UPDATE_URL: 'https://example.test/updates/' }), 'https://example.test/updates/')
  assert.equal(layout.updateFeed({}), 'https://139.155.78.241:8710/updates')
})

test('自启命令：打包版只带 exe，开发版带 app 路径', () => {
  assert.equal(layout.loginCommand({ executable: 'C:/Qingmei.exe', packaged: true }), '"C:/Qingmei.exe"')
  assert.equal(
    layout.loginCommand({ executable: 'C:/electron.exe', appPath: 'C:/app', packaged: false }),
    '"C:/electron.exe" "C:/app"',
  )
})
