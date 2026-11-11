/**
 * 桌面版更新器（替代 electron-updater）。
 *
 * 为什么不用 electron-updater：它只会驱动 NSIS 安装包（按 NSIS 参数静默安装、
 * 依赖 latest.yml + blockmap 做差量）。青梅改用 Inno Setup 后，更新流程简化成：
 *   1. GET  /updates/desktop/latest.json     （版本、地址、sha256、说明）
 *   2. 比较版本，比本机新就下载到临时目录
 *   3. 校验 sha256
 *   4. 静默运行安装包（/VERYSILENT），退出应用
 * 任意旧版本都能一步升到最新，不需要逐版本。
 *
 * 纯函数（版本比较、清单校验）放在文件上半部分，便于单测。
 */
const { createHash } = require('node:crypto')
const { createWriteStream, existsSync, mkdirSync } = require('node:fs')
const { readFile } = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const http = require('node:http')
const https = require('node:https')

/** 语义化版本比较：只认 x.y.z（青梅自己的版本就长这样）。返回 -1 / 0 / 1。 */
function compareVersions(a, b) {
  const parse = (value) => String(value ?? '').trim().replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/** 校验更新清单；字段不全就返回 null，调用方按「没有更新」处理。 */
function parseManifest(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const version = typeof value.version === 'string' ? value.version.trim() : ''
  const url = typeof value.url === 'string' ? value.url.trim() : ''
  const sha256 = typeof value.sha256 === 'string' ? value.sha256.trim().toLowerCase() : ''
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^https?:\/\//i.test(url) || !/^[0-9a-f]{64}$/.test(sha256)) return null
  return {
    version,
    url,
    sha256,
    size: Number(value.size) || 0,
    notes: typeof value.notes === 'string' ? value.notes : '',
    at: typeof value.at === 'string' ? value.at : '',
  }
}

/** 有更新就返回清单，否则 null。 */
function pickUpdate(currentVersion, manifest) {
  if (!manifest) return null
  return compareVersions(manifest.version, currentVersion) > 0 ? manifest : null
}

async function sha256File(file) {
  const buffer = await readFile(file)
  return createHash('sha256').update(buffer).digest('hex')
}

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http
    const request = client.get(url, { timeout: 30_000 }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location && redirects < 5) {
        response.resume()
        resolve(get(new URL(response.headers.location, url).toString(), redirects + 1))
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`HTTP ${status}：${url}`))
        return
      }
      resolve(response)
    })
    request.on('timeout', () => request.destroy(new Error(`请求超时：${url}`)))
    request.on('error', reject)
  })
}

async function fetchJson(url) {
  const response = await get(url)
  let text = ''
  for await (const chunk of response) text += chunk
  return text
}

/** 下载到 dest；progress 回调收到 0..1（总大小未知时为 -1）。 */
async function downloadFile(url, dest, progress) {
  mkdirSync(path.dirname(dest), { recursive: true })
  const response = await get(url)
  const total = Number(response.headers['content-length']) || 0
  let received = 0
  const stream = createWriteStream(dest)
  try {
    for await (const chunk of response) {
      received += chunk.length
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve))
      if (typeof progress === 'function') progress(total > 0 ? received / total : -1)
    }
  } finally {
    await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())))
  }
  return received
}

/** 静默运行安装包；安装器会覆盖安装并保留 %APPDATA% 下的设置。 */
function runInstaller(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS'], {
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.unref()
    resolve()
  })
}

/**
 * 检查并下载更新；返回更新清单或 null。
 * 不在这里弹窗/安装——UI 决策留给 main.cjs。
 */
async function checkForUpdate({ feed, currentVersion, timeoutMs = 15_000 }) {
  const base = String(feed ?? '').replace(/\/+$/, '')
  if (!base) return null
  const url = `${base}/desktop/latest.json`
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`检查更新超时：${url}`)), timeoutMs))
  const text = await Promise.race([fetchJson(url), timeout])
  return pickUpdate(currentVersion, parseManifest(text))
}

module.exports = {
  compareVersions,
  parseManifest,
  pickUpdate,
  sha256File,
  downloadFile,
  runInstaller,
  checkForUpdate,
}
