import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(join(root, relative), 'utf8')

const html = read('renderer/index.html')
const app = read('renderer/app.mjs')
const css = read('renderer/style.css')
const main = read('electron/main.cjs')
const pkg = JSON.parse(read('package.json'))
const preload = read('electron/preload.cjs')

test('桌宠窗口：透明、无边框、置顶、跳过任务栏', () => {
  assert.match(main, /transparent:\s*true/)
  assert.match(main, /frame:\s*false/)
  assert.match(main, /alwaysOnTop:\s*true/)
  assert.match(main, /skipTaskbar:\s*true/)
  assert.match(main, /preload:\s*path\.join/)
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.equal(pkg.main, 'electron/main.cjs')
  assert.ok(pkg.devDependencies.electron)
})

test('preload 只暴露最小 API', () => {
  assert.match(preload, /contextBridge\.exposeInMainWorld\('qmDesktop'/)
  assert.match(preload, /getSettings/)
  assert.match(preload, /saveSettings/)
  assert.match(preload, /popupMenu/)
  assert.doesNotMatch(preload, /require\('node:fs'\)/)
})

test('界面元素齐全', () => {
  for (const id of [
    'drag-handle',
    'bubble',
    'bubble-text',
    'bubble-close',
    'chat',
    'chat-log',
    'chat-input',
    'chat-send',
    'pet',
    'zzz',
    'hearts',
    'settings-modal',
    'settings-server',
    'settings-token',
    'settings-scale',
    'settings-sound',
    'settings-autostart',
    'settings-notify-hidden',
    'settings-hide-fullscreen',
    'settings-character',
    'onboarding',
    'onboarding-start',
    'pet-orb',
    'settings-save',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`)
  }
  assert.match(html, /<video[^>]*id="pet"/)
  for (const clip of ['idle-breath', 'idle-look', 'sleep', 'think', 'eat-rice', 'drag', 'click-happy', 'click-wave', 'click-shy', 'click-pout', 'click-tickle', 'fun-mirror', 'fun-whale', 'fun-water']) {
    assert.ok(existsSync(join(root, 'renderer', 'assets', 'webm', clip + '.webm')), '缺少动画 ' + clip + '.webm')
  }
})

test('通知与输入走现有 Web 协议', () => {
  assert.match(app, /new EventSource\(/)
  assert.match(app, /bubbleForEvent/)
  assert.match(app, /\/api\/v1\/messages/)
  assert.match(app, /Authorization:\s*`Bearer \$\{settings\.token\}`/)
  assert.match(app, /conversationId:\s*'owner'/)
  assert.match(app, /BubbleQueue/)
})

test('交互：点击/右键/拖动/设置', () => {
  assert.match(app, /addEventListener\('click'/)
  assert.match(app, /addEventListener\('contextmenu'/)
  assert.match(app, /popupMenu/)
  assert.match(css, /-webkit-app-region:\s*drag/)
  assert.match(css, /-webkit-app-region:\s*no-drag/)
  assert.match(main, /摸摸头/);
  assert.match(main, /选个动作/);
  assert.match(app, /sendImage/);
  assert.match(app, /api\/v1\/uploads/);
  assert.match(app, /onboardingStart/);
  assert.match(main, /喂饭/);
  assert.match(main, /逗一下/);
  assert.match(app, /onPetAction/);
  assert.match(app, /playFun/);
  assert.match(app, /setIgnoreMouseEvents\(true\)/)
  assert.match(app, /elementFromPoint/)
  assert.match(main, /setZoomFactor/);
  assert.match(main, /setLoginItemSettings/);
  assert.match(main, /notify:show/);
  assert.match(app, /addEventListener\('chunk'/) ;
  assert.match(app, /renderMarkdown/);
  assert.match(app, /flushOutbox/);
  assert.match(app, /OUTBOX_KEY/);
  assert.match(main, /setFullscreenWatch/);
  assert.match(main, /fullscreen\.ps1/);
  assert.ok(existsSync(join(root, 'electron', 'fullscreen.ps1')));
  assert.match(main, /setIgnoreMouseEvents/)
  assert.match(preload, /setIgnoreMouseEvents/)
  assert.match(html, /id="drag-handle"/)
})
