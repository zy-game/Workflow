/**
 * 青梅桌面宿主（桌宠）主进程。
 *
 * 透明、无边框、置顶、跳过任务栏；渲染层只通过 preload 暴露的最小 API
 * 读写设置与退出，不直接拿 Node。
 */
const { app, BrowserWindow, Notification, ipcMain, Menu, safeStorage, screen, shell, Tray, nativeImage } = require('electron')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { writeWorkerConfig } = require('./agent-config.cjs')
const { execFile, execFileSync, spawn } = require('node:child_process')
const { defaultBoundsIn, isVisibleInDisplays, clampToDisplays, updateFeed, loginCommand } = require('./layout.cjs')


const here = __dirname
process.on('uncaughtException', (error) => console.error('[qingmei] uncaught', error))
process.on('unhandledRejection', (error) => console.error('[qingmei] rejection', error))
const rendererDir = path.join(here, '..', 'renderer')
// Windows 上中文 userData 路径会让打包版 Electron 启动崩溃；统一用 ASCII 目录。
// 显式 --user-data-dir 仍优先（测试/多实例用）。
if (!process.argv.some((arg) => arg.startsWith('--user-data-dir'))) {
  const candidates = []
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'qingmei-data'))
  }
  candidates.push(
    path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'qingmei-desktop'),
    path.join(app.getPath('home'), '.qingmei-desktop'),
  )
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true })
      app.setPath('userData', candidate)
      break
    } catch {
      // 该目录不可写就试下一个（CI/受限账户下 AppData 可能不可写）
    }
  }
}

let win = null
let tray = null
let settingsCache = null
let fullscreenTimer = null
let hiddenByFullscreen = false
const liveNotifications = new Set()

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
    mcpToken: decryptMcpToken(stored),
    bounds: stored.bounds && typeof stored.bounds === 'object' ? stored.bounds : null,
    scale: clampScale(stored.scale),
    fontScale: clampFontScale(stored.fontScale),
    sound: stored.sound !== false,
    autoStart: stored.autoStart === true,
    notifyHidden: stored.notifyHidden !== false,
    hideOnFullscreen: stored.hideOnFullscreen === true,
    character: stored.character === 'orb' ? 'orb' : 'qingmei',
  }
  return settingsCache
}

function clampScale(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(1.5, Math.max(0.7, number)) : 1
}

function clampFontScale(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(1.3, Math.max(0.85, number)) : 1
}

function decryptMcpToken(stored) {
  if (typeof stored.mcpTokenEnc === 'string' && stored.mcpTokenEnc) {
    try {
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(stored.mcpTokenEnc, 'base64')) : ''
    } catch {
      return ''
    }
  }
  if (typeof stored.mcpTokenPlain === 'string') return stored.mcpTokenPlain
  return process.env.QM_MCP_TOKEN || ''
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
  const payload = {
    serverUrl: settings.serverUrl,
    bounds: settings.bounds ?? null,
    scale: clampScale(settings.scale),
    fontScale: clampFontScale(settings.fontScale),
    sound: settings.sound !== false,
    autoStart: settings.autoStart === true,
    notifyHidden: settings.notifyHidden !== false,
    hideOnFullscreen: settings.hideOnFullscreen === true,
    character: settings.character === 'orb' ? 'orb' : 'qingmei',
  }
  if (settings.token) {
    if (safeStorage.isEncryptionAvailable()) payload.tokenEnc = safeStorage.encryptString(settings.token).toString('base64')
    else payload.tokenPlain = settings.token
  }
  if (settings.mcpToken) {
    if (safeStorage.isEncryptionAvailable()) payload.mcpTokenEnc = safeStorage.encryptString(settings.mcpToken).toString('base64')
    else payload.mcpTokenPlain = settings.mcpToken
  }
  writeFileSync(settingsPath(), JSON.stringify(payload, null, 2), 'utf8')
  settingsCache = settings
}

function mcpEndpoint(settings) {
  const base = String(settings.serverUrl || '').replace(/\/+$/, '')
  return process.env.QM_MCP_URL || `${base}/mcp`
}

function setupAgent(target) {
  const settings = readSettings()
  if (!settings.mcpToken) return { ok: false, error: '请先填写 MCP Token' }
  const home = app.getPath('home')
  const url = mcpEndpoint(settings)
  const headers = { Authorization: `Bearer ${settings.mcpToken}` }
  const zcodePath = path.join(home, '.zcode', 'cli', 'config.json')
  const dshPath = path.join(home, '.dsh', 'mcp.servers.yml')
  const agentsPath = path.join(home, '.agents', 'mcp.json')
  const server = { type: 'http', url, headers }
  if (target === 'zcode' || target === 'both') {
    let config = {}
    try {
      if (existsSync(zcodePath)) config = JSON.parse(readFileSync(zcodePath, 'utf8'))
    } catch {
      config = {}
    }
    config.mcp = config.mcp && typeof config.mcp === 'object' ? config.mcp : {}
    config.mcp.servers = config.mcp.servers && typeof config.mcp.servers === 'object' ? config.mcp.servers : {}
    config.mcp.servers.qingmei = server
    mkdirSync(path.dirname(zcodePath), { recursive: true })
    writeFileSync(zcodePath, JSON.stringify(config, null, 2), 'utf8')
  }
  if (target === 'dsh' || target === 'both') {
    mkdirSync(path.dirname(dshPath), { recursive: true })
    writeFileSync(
      dshPath,
      ['qingmei:', '  type: http', `  url: ${url}`, '  headers:', `    Authorization: Bearer ${settings.mcpToken}`, ''].join('\n'),
      'utf8',
    )
  }
  if (target === 'zcode' || target === 'dsh' || target === 'both') {
    let agents = { mcpServers: {} }
    try {
      if (existsSync(agentsPath)) agents = JSON.parse(readFileSync(agentsPath, 'utf8'))
    } catch {
      agents = { mcpServers: {} }
    }
    agents.mcpServers = agents.mcpServers && typeof agents.mcpServers === 'object' ? agents.mcpServers : {}
    agents.mcpServers.qingmei = server
    mkdirSync(path.dirname(agentsPath), { recursive: true })
    writeFileSync(agentsPath, JSON.stringify(agents, null, 2), 'utf8')
  }
  if (target === 'worker') {
    const workerPath = path.join(home, '.qingmei', 'worker.json')
    mkdirSync(path.dirname(workerPath), { recursive: true })
    writeFileSync(
      workerPath,
      JSON.stringify(
        {
          server: settings.serverUrl.replace(/\/+$/, ''),
          token: settings.token,
          mcpUrl: url,
          mcpToken: settings.mcpToken,
          name: `${os.hostname()} (Windows)`,
          deviceId: `dev-${os.hostname().replace(/[^a-zA-Z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
          dshCommand: 'dsh',
        },
        null,
        2,
      ),
      'utf8',
    )
  }
  const names = { zcode: 'ZCode', dsh: 'DSH', both: 'ZCode + DSH', worker: '本机 Worker' }
  return { ok: true, message: `已配置 ${names[target] || target} 的 MCP；地址 ${url}` }
}
function startWorker() {
  const script = path.join(here, '..', '..', 'scripts', 'harness-worker.mjs')
  if (!existsSync(script)) return { ok: false, error: '找不到 scripts/harness-worker.mjs' }
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: path.join(here, '..', '..'),
  })
  child.unref()
  return { ok: true, message: 'Worker 已启动；配置来自 ~/.qingmei/worker.json' }
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

function windowsLoginCommand() {
  const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  return loginCommand({ executable, appPath: app.getAppPath(), packaged: app.isPackaged })
}

function setupUpdates() {
  if (!app.isPackaged) return
  const feed = updateFeed(process.env)
  if (!feed) return
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    autoUpdater
      .checkForUpdatesAndNotify()
      .catch((error) => console.error('[qingmei] 检查更新失败', error))
  } catch (error) {
    console.error('[qingmei] 初始化自动更新失败', error)
  }
}

function applyAutoStart(enabled) {
  if (process.platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    try {
      if (enabled) {
        execFileSync('reg', ['add', key, '/v', 'Qingmei', '/t', 'REG_SZ', '/d', windowsLoginCommand(), '/f'], {
          windowsHide: true,
        })
      } else {
        execFileSync('reg', ['delete', key, '/v', 'Qingmei', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        })
      }
      return
    } catch (error) {
      console.error('[qingmei] 注册表开机自启失败，回退 Electron API', error)
    }
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      ...(app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] }),
    })
  } catch (error) {
    console.error('[qingmei] 设置开机自启失败', error)
  }
}

function resizeForScale(scale) {
  if (!win || win.isDestroyed()) return
  const previous = win.getBounds()
  const width = Math.round(380 * scale)
  const height = Math.round(560 * scale)
  win.webContents.setZoomFactor(scale)
  win.setBounds(
    clampToDisplays(
      { x: previous.x + previous.width - width, y: previous.y + previous.height - height, width, height },
      screen.getAllDisplays(),
    ),
  )
}

function boundsVisible(bounds) {
  return isVisibleInDisplays(bounds, screen.getAllDisplays())
}

function checkFullscreen() {
  if (!win || win.isDestroyed() || !readSettings().hideOnFullscreen) return
  const helper = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'fullscreen.exe')
    : path.join(here, 'fullscreen.exe')
  execFile(
    helper,
    [],
    { timeout: 5000, windowsHide: true },
    (error, stdout) => {
      if (process.env.QM_DESKTOP_DEBUG) {
        try {
          require('node:fs').appendFileSync(process.env.QM_DESKTOP_DEBUG, 'fs error=' + (error?.message ?? '') + ' out=' + String(stdout).trim() + '\n')
        } catch {}
      }
      if (error || !win || win.isDestroyed()) return
      const fullscreen = String(stdout).trim() === '1'
      if (fullscreen && win.isVisible()) {
        hiddenByFullscreen = true
        win.hide()
      } else if (!fullscreen && hiddenByFullscreen) {
        hiddenByFullscreen = false
        win.showInactive()
      }
    },
  )
}

function setFullscreenWatch(enabled) {
  clearInterval(fullscreenTimer)
  fullscreenTimer = null
  if (!enabled || process.platform !== 'win32') return
  fullscreenTimer = setInterval(checkFullscreen, 6000)
  fullscreenTimer.unref?.()
}

function defaultBounds(scale = 1) {
  return defaultBoundsIn(screen.getPrimaryDisplay().workArea, scale)
}

function createWindow() {
  const settings = readSettings()
  const scale = clampScale(settings.scale)
  const width = Math.round(380 * scale)
  const height = Math.round(560 * scale)
  const saved = settings.bounds && boundsVisible(settings.bounds) ? settings.bounds : null
  const bounds = saved ? { ...saved, width, height } : defaultBounds(scale)
  win = new BrowserWindow({
    ...bounds,
    width,
    height,
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
  win.loadFile(path.join(rendererDir, 'index.html'))
  win.once('ready-to-show', () => {
    win.webContents.setZoomFactor(scale)
    win.showInactive()
    if (!app.isPackaged) {
    const action = process.env.QM_DESKTOP_ACTION
    if (action === 'feed') {
      setTimeout(() => {
        void win.webContents.executeJavaScript(
          "document.getElementById('pet').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))",
        )
      }, 600)
    }
    if (action === 'chat') {
      setTimeout(() => {
        void win.webContents.executeJavaScript("document.getElementById('bubble-text').click()")
      }, 600)
    }
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
                  petSrc: document.getElementById('pet')?.getAttribute('src'),
                  petTime: document.getElementById('pet')?.currentTime,
                  petPaused: document.getElementById('pet')?.paused,
                  viewport: [window.innerWidth, window.innerHeight],
                  dpr: window.devicePixelRatio,
                })
              `)
              writeFileSync(`${shot}.json`, info)
            } catch {}
          })
          .catch(() => undefined)
          .finally(() => app.quit())
      }, delay)
    }
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
    setFullscreenWatch(readSettings().hideOnFullscreen)
    applyAutoStart(readSettings().autoStart)
    setupUpdates()

    ipcMain.handle('settings:get', () => {
      const settings = readSettings()
      return {
        serverUrl: settings.serverUrl,
        token: settings.token,
        mcpToken: settings.mcpToken,
        hasToken: Boolean(settings.token),
        scale: settings.scale,
        fontScale: settings.fontScale,
        sound: settings.sound,
        autoStart: settings.autoStart,
        notifyHidden: settings.notifyHidden,
        hideOnFullscreen: settings.hideOnFullscreen,
        character: settings.character,
      }
    })

    ipcMain.handle('settings:save', (_event, incoming) => {
      const serverUrl = typeof incoming?.serverUrl === 'string' ? incoming.serverUrl.trim() : ''
      const token = typeof incoming?.token === 'string' ? incoming.token.trim() : ''
      const mcpToken = typeof incoming?.mcpToken === 'string' ? incoming.mcpToken.trim() : current.mcpToken
      if (!/^https?:\/\/\S+$/i.test(serverUrl)) throw new Error('服务器地址必须是 http(s) URL')
      const current = readSettings()
      const scale = clampScale(incoming?.scale ?? current.scale)
      const fontScale = clampFontScale(incoming?.fontScale ?? current.fontScale)
      const settings = {
        ...current,
        serverUrl,
        token,
        mcpToken,
        scale,
        fontScale,
        sound: incoming?.sound !== false,
        autoStart: incoming?.autoStart === true,
        notifyHidden: incoming?.notifyHidden !== false,
        hideOnFullscreen: incoming?.hideOnFullscreen === true,
        character: incoming?.character === 'orb' ? 'orb' : 'qingmei',
      }
      if (scale !== current.scale) {
        resizeForScale(scale)
        if (win && !win.isDestroyed()) settings.bounds = win.getBounds()
      }
      persist(settings)
      applyAutoStart(settings.autoStart)
      setFullscreenWatch(settings.hideOnFullscreen)
      return { ok: true, scale }
    })

    ipcMain.handle('agent:worker-config', () =>
      writeWorkerConfig({ settings: readSettings(), home: app.getPath('home') }),
    )
    ipcMain.handle('agent:worker-start', () => startWorker())
    ipcMain.handle('menu:popup', () => {
      Menu.buildFromTemplate([
        { label: '摸摸头', click: () => win?.webContents.send('pet-action', 'pet') },
        { label: '喂饭', click: () => win?.webContents.send('pet-action', 'feed') },
        { label: '逗一下', click: () => win?.webContents.send('pet-action', 'play') },
        {
          label: '选个动作…',
          submenu: [
            { label: '照镜子', click: () => win?.webContents.send('pet-action', 'play:mirror') },
            { label: '蓝鲸现世', click: () => win?.webContents.send('pet-action', 'play:whale') },
            { label: '玩水枪', click: () => win?.webContents.send('pet-action', 'play:water') },
            { label: '吃白饭', click: () => win?.webContents.send('pet-action', 'play:eat') },
            { label: '元气挥手', click: () => win?.webContents.send('pet-action', 'play:wave') },
            { label: '打盹', click: () => win?.webContents.send('pet-action', 'play:sleep') },
          ],
        },
        { label: '聊聊天', click: () => win?.webContents.send('pet-action', 'chat') },
        { type: 'separator' },
        { label: '设置…', click: () => win?.webContents.send('open-settings') },
        { label: '重新连接', click: () => win?.webContents.send('reconnect') },
        { label: '躲起来', click: () => win?.hide() },
        { type: 'separator' },
        { label: '退出青梅', click: () => app.quit() },
      ]).popup({ window: win ?? undefined })
      return true
    })

    ipcMain.handle('notify:show', (_event, payload) => {
      if (!win || win.isVisible()) return false
      const notification = new Notification({
        title: String(payload?.title ?? '青梅'),
        body: String(payload?.body ?? '').slice(0, 240),
        silent: true,
      })
      liveNotifications.add(notification)
      notification.on('click', () => {
        win?.show()
        win?.focus()
      })
      notification.on('close', () => liveNotifications.delete(notification))
      notification.show()
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
      const next = clampToDisplays({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }, screen.getAllDisplays())
      win.setPosition(next.x, next.y)
    })

    ipcMain.on('window:hide', () => win?.hide())

    createTray()
  })

  app.on('window-all-closed', () => app.quit())
}
