import { Capacitor, registerPlugin } from '@capacitor/core'

// 原生插件在 Android 包里注册；Web/桌面构建里 isNativePlatform() 为 false，不会触发。
const QmUpdater = registerPlugin('QmUpdater')

function serverBase() {
  return String(window.__QM_SERVER_URL || '').replace(/\/+$/, '')
}

/**
 * 拉更新清单并与本机 versionCode 比较。
 * 返回 null 表示：非 Android、没有服务器地址、检查失败，或已是最新。
 */
export async function checkAndroidUpdate() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null
  const base = serverBase()
  if (!base) return null

  const res = await fetch(`${base}/updates/android/latest.json`, { cache: 'no-store' })
  if (!res.ok) return null
  const latest = await res.json()
  const info = await QmUpdater.getInfo()
  const current = Number(info?.versionCode) || 0
  const next = Number(latest?.versionCode) || 0
  if (!next || next <= current) return null
  return {
    ...latest,
    url: latest.url || `${base}/updates/android/${latest.name}`,
    current,
    currentName: info?.versionName || '',
  }
}

export async function installAndroidUpdate(latest) {
  if (!latest?.url) throw new Error('缺少下载地址')
  await QmUpdater.downloadAndInstall({
    url: latest.url,
    sha256: latest.sha256 || '',
  })
}
