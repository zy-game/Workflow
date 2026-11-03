/**
 * 青梅桌面宿主（桌宠）主进程。
 *
 * 透明、无边框、置顶、跳过任务栏；渲染层只通过 preload 暴露的最小 API
 * 读写设置与退出，不直接拿 Node。
 */
const { app, BrowserWindow, ipcMain, Menu, safeStorage, screen, shell, Tray, nativeImage } = require('electron')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')


const here = __dirname
const bootFile = path.join(here, 'boot.log')
function boot(msg) { try { require('node:fs').appendFileSync(bootFile, new Date().toISOString() + ' ' + msg + '\n') } catch {} }
boot('module loaded'); process.on('uncaughtException', (e) => boot('uncaught ' + (e && e.stack || e))); process.on('unhandledRejection', (e) => boot('rejection ' + (e && e.stack || e)))
const rendererDir = path.join(here, '..', 'renderer')

let win = null
let tray = null
let settingsCache = null

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettings() {
  if (settingsCache) return settingsCache
  let stored = {}
  try {
    if (existsSync(settingsPath())) stored = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    stored = {}
  }
  settingsCache = {
    serverUrl: typeof stored.serverUrl === 'string' ? stored.serverUrl : process.env.QM_SERVER_URL || 'http://127.0.0.1:7410',
    token: decryptToken(stored),
    bounds: stored.bounds && typeof stored.bounds === 'object' ? stored.bounds : null,
  }
  return settingsCache
}

function decryptToken(stored) {
  if (typeof stored.tokenEnc === 'string' && stored.tokenEnc) {
    try {
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(stored.tokenEnc, 'base64')) : ''
    } catch {
      return ''
    }
  }
  if (typeof stored.tokenPlain === 'string') return stored.tokenPlain
  return process.env.QM_TOKEN || ''
}

function persist(settings) {
  const dir = path.dirname(settingsPath())
  mkdirSync(dir, { recursive: true })
  const payload = { serverUrl: settings.serverUrl, bounds: settings.bounds ?? null }
  if (settings.token) {
    if (safeStorage.isEncryptionAvailable()) payload.tokenEnc = safeStorage.encryptString(settings.token).toString('base64')
    else payload.tokenPlain = settings.token
  }
  writeFileSync(settingsPath(), JSON.stringify(payload, null, 2), 'utf8')
  settingsCache = settings
}

function createTray() {
  try {
    const iconPath = path.join(here, '..', 'docs', 'pet-preview.png')
    const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    tray = new Tray(image)
    tray.setToolTip('青梅')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示青梅', click: () => { win?.show(); win?.focus() } },
        { label: '隐藏青梅', click: () => win?.hide() },
        { type: 'separator' },
        { label: '设置…', click: () => { win?.show(); win?.webContents.send('open-settings') } },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]),
    )
    tray.on('double-click', () => { win?.show(); win?.focus() })
  } catch {
    // 托盘不可用不影响桌宠
  }
}

function defaultBounds() {
  const area = screen.getPrimaryDisplay().workArea
  const width = 380
  const height = 560
  return {
    width,
    height,
    x: Math.round(area.x + area.width - width - 24),
    y: Math.round(area.y + area.height - height - 12),
  }
}

function createWindow() {
  boot('createWindow')
  const settings = readSettings()
  const bounds = settings.bounds ?? defaultBounds()
  win = new BrowserWindow({
    ...bounds,
    width: 380,
    height: 560,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.on('render-process-gone', (_e, details) => boot('render gone ' + JSON.stringify(details)))
  win.webContents.on('did-fail-load', (_e, code, desc) => boot('fail load ' + code + ' ' + desc))
  win.loadFile(path.join(rendererDir, 'index.html'))
  win.once('ready-to-show', () => {
    boot('ready-to-show')
    win.showInactive()
    const shot = process.env.QM_DESKTOP_SCREENSHOT
    if (shot) {
      win.webContents.on('console-message', (_event, level, message) => {
        try {
          require('node:fs').appendFileSync(`${shot}.log`, `${new Date().toISOString()} [${level}] ${message}\n`)
        } catch {}
      })
      const delay = Number(process.env.QM_DESKTOP_SCREENSHOT_DELAY ?? 1200)
      setTimeout(() => {
        void win.webContents
          .capturePage()
          .then(async (image) => {
            writeFileSync(shot, image.toPNG())
            try {
              const info = await win.webContents.executeJavaScript(`
                JSON.stringify({
                  state: document.getElementById('app')?.dataset.state,
                  dot: document.getElementById('status-dot')?.className,
                  bubbleHidden: document.getElementById('bubble')?.hidden,
                  bubbleText: document.getElementById('bubble-text')?.textContent,
                  chatHidden: document.getElementById('chat')?.hidden,
                  videoTime: document.getElementById('pet')?.currentTime,
                  videoPaused: document.getElementById('pet')?.paused,
                })
              `)
              writeFileSync(`${shot}.json`, info)
            } catch {}
          })
          .catch(() => undefined)
          .finally(() => app.quit())
      }, delay)
    }
  })
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return
    const current = win.getBounds()
    settingsCache = { ...readSettings(), bounds: current }
    persist(settingsCache)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.show()
  })
  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.hide()
    Menu.setApplicationMenu(null)
    createWindow()

    ipcMain.handle('settings:get', () => {
      const settings = readSettings()
      return { serverUrl: settings.serverUrl, token: settings.token, hasToken: Boolean(settings.token) }
    })

    ipcMain.handle('settings:save', (_event, incoming) => {
      const serverUrl = typeof incoming?.serverUrl === 'string' ? incoming.serverUrl.trim() : ''
      const token = typeof incoming?.token === 'string' ? incoming.token.trim() : ''
      if (!/^https?:\/\/\S+$/i.test(serverUrl)) throw new Error('服务器地址必须是 http(s) URL')
      const settings = { ...readSettings(), serverUrl, token }
      persist(settings)
      return { ok: true }
    })

    ipcMain.handle('menu:popup', () => {
      Menu.buildFromTemplate([
        { label: '设置…', click: () => win?.webContents.send('open-settings') },
        { label: '重新连接', click: () => win?.webContents.send('reconnect') },
        { type: 'separator' },
        { label: '退出青梅', click: () => app.quit() },
      ]).popup({ window: win ?? undefined })
      return true
    })

    ipcMain.on('app:quit', () => app.quit())

    // 透明区域点击穿透：渲染层判断指针是否落在桌宠/气泡/聊天/设置上
    ipcMain.on('window:ignore-mouse', (_event, ignore) => {
      if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
    })

    // 整只桌宠拖动：渲染层算屏幕坐标增量，主进程移动窗口
    ipcMain.on('window:move-by', (_event, delta) => {
      if (!win || win.isDestroyed()) return
      const dx = Math.round(Number(delta?.dx) || 0)
      const dy = Math.round(Number(delta?.dy) || 0)
      if (!dx && !dy) return
      const bounds = win.getBounds()
      win.setPosition(bounds.x + dx, bounds.y + dy)
    })

    ipcMain.on('window:hide', () => win?.hide())

    createTray()
  })

  app.on('window-all-closed', () => app.quit())
}
