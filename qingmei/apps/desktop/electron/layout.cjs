/**
 * 桌面窗口的多屏/DPI 纯函数。
 *
 * 不依赖 Electron；测试用假的 display/workArea 覆盖主屏、副屏、负坐标和缩放。
 */
const DEFAULT_WIDTH = 380
const DEFAULT_HEIGHT = 560

function areaOf(display) {
  if (display?.workArea) return display.workArea
  if (display?.bounds) return display.bounds
  return display ?? { x: 0, y: 0, width: 0, height: 0 }
}

function defaultBoundsIn(area, scale = 1) {
  const width = Math.round(DEFAULT_WIDTH * scale)
  const height = Math.round(DEFAULT_HEIGHT * scale)
  const workArea = areaOf(area)
  return {
    width,
    height,
    x: Math.round(workArea.x + workArea.width - width - 24),
    y: Math.round(workArea.y + workArea.height - height - 12),
  }
}

function isVisibleInDisplays(bounds, displays) {
  if (!bounds) return false
  return displays.some((display) => {
    const area = areaOf(display)
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    )
  })
}

function clampToDisplays(bounds, displays) {
  if (!bounds || !isVisibleInDisplays(bounds, displays)) return bounds
  const area = displays
    .map(areaOf)
    .find(
      (item) =>
        bounds.x < item.x + item.width &&
        bounds.x + bounds.width > item.x &&
        bounds.y < item.y + item.height &&
        bounds.y + bounds.height > item.y,
    )
  if (!area) return bounds
  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height),
  }
}

function loginCommand({ executable, appPath = '', packaged = false }) {
  if (!executable) throw new Error('executable 不能为空')
  return packaged ? `"${executable}"` : `"${executable}" "${appPath}"`
}

function updateFeed(env = process.env, fallback = 'https://139.155.78.241:8710/updates') {
  const value = String(env?.QM_UPDATE_URL ?? '').trim()
  return value || fallback
}

module.exports = { defaultBoundsIn, isVisibleInDisplays, clampToDisplays, updateFeed, loginCommand }
