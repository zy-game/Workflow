<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NAV } from './router.js'
import LoginModal from './components/LoginModal.vue'
import UpdatePrompt from './components/UpdatePrompt.vue'
import { ENDPOINTS } from './lib/endpoints.js'
import { request } from './lib/api.js'
import { checkAndroidUpdate } from './lib/updater.js'
import { session, hasAuth, loadToken, readUrlToken, saveToken, setStatus } from './lib/session.js'
import { closeEvents, connect } from './lib/sse.js'
import { on as onBus } from './lib/bus.js'

const route = useRoute()
const loginOpen = ref(false)
const update = ref(null)
const drawerOpen = ref(false)
const drawerTrigger = ref(null)
const navRef = ref(null)
const currentTitle = computed(() => route.meta?.title || '控制台')
let narrowViewport = null
const offlineNotice = ref('')
let offOffline = null

function closeDrawer(restoreFocus = false) {
  if (!drawerOpen.value) return
  drawerOpen.value = false
  if (restoreFocus) drawerTrigger.value?.focus()
}

async function toggleDrawer() {
  if (drawerOpen.value) {
    closeDrawer(true)
    return
  }
  drawerOpen.value = true
  await nextTick()
  navRef.value?.querySelector('.nav-link.router-link-active')?.focus()
}

function handleKeydown(event) {
  if (event.key === 'Escape') closeDrawer(true)
}

function handleViewportChange(event) {
  if (!event.matches) closeDrawer()
}

watch(
  () => route.fullPath,
  () => closeDrawer(),
)

async function probeHealth() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(ENDPOINTS.health, { cache: 'no-store', signal: controller.signal })
    if (res.ok) {
      setStatus('online')
      return
    }
    if (res.status === 401 || res.status === 403) {
      setStatus('error', '令牌无效')
      return
    }
    setStatus('offline', `服务异常（${res.status}）`)
  } catch {
    setStatus('offline', '无法连接服务')
  } finally {
    clearTimeout(timer)
  }
}

async function probeCookieSession() {
  try {
    const res = await fetch(ENDPOINTS.session, { credentials: 'include', cache: 'no-store' })
    if (res.ok) session.cookieAuth = true
  } catch {
    // 离线时留在登录门
  }
}

async function readSecureToken() {
  const plugin = window.Capacitor?.Plugins?.SecureStore
  if (!plugin) return ''
  try {
    const result = await plugin.get({ key: 'qm.token' })
    return result?.value || ''
  } catch {
    return ''
  }
}

async function bootAuth() {
  session.token = readUrlToken() || loadToken()
  if (!hasAuth()) await probeCookieSession()
  if (!hasAuth()) {
    const secure = await readSecureToken()
    if (secure) {
      session.token = secure
      saveToken(secure)
    }
  }
  if (!hasAuth()) {
    setStatus('offline', '需要登录')
    loginOpen.value = true
    return
  }
  await finishBoot()
}

async function finishBoot() {
  loginOpen.value = false
  session.authReady = true
  await probeHealth()
  connect()
}

async function checkUpdate() {
  try {
    update.value = await checkAndroidUpdate()
  } catch {
    // 更新检查失败不打扰正常使用
  }
}

function handleOffline() {
  closeEvents()
  setStatus('offline', '网络已断开')
}

function handleOnline() {
  session.reconnectAttempt = 0
  connect()
}

onMounted(() => {
  window.addEventListener('offline', handleOffline)
  window.addEventListener('online', handleOnline)
  window.addEventListener('keydown', handleKeydown)
  narrowViewport = window.matchMedia('(max-width: 720px)')
  narrowViewport.addEventListener('change', handleViewportChange)
  offOffline = onBus('device-offline', (payload) => {
    offlineNotice.value = payload?.message ?? '执行设备离线，任务在排队。'
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('青梅', { body: offlineNotice.value })
    }
  })
  void bootAuth()
  void checkUpdate()
})

onBeforeUnmount(() => {
  window.removeEventListener('offline', handleOffline)
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('keydown', handleKeydown)
  narrowViewport?.removeEventListener('change', handleViewportChange)
  offOffline?.()
  closeEvents()
})
</script>

<template>
  <div class="shell" :class="{ 'drawer-open': drawerOpen }">
    <div v-if="offlineNotice" class="notice-banner" role="status">
      {{ offlineNotice }}
      <button class="btn small ghost" type="button" @click="offlineNotice = ''">知道了</button>
    </div>
    <header class="topbar">
      <button
        ref="drawerTrigger"
        class="brand drawer-trigger"
        type="button"
        aria-controls="app-nav"
        :aria-expanded="drawerOpen"
        :aria-label="drawerOpen ? '收起菜单' : '展开菜单'"
        @click="toggleDrawer"
      >
        <span class="brand-dot" aria-hidden="true"></span>
        <span class="brand-name">青梅</span>
        <span class="drawer-chevron" aria-hidden="true"></span>
      </button>
      <span class="topbar-title">{{ currentTitle }}</span>
      <span class="status-pill topbar-status" :data-state="session.status" aria-hidden="true">
        <span class="status-dot"></span>
      </span>
    </header>

    <aside id="app-nav" class="sidebar">
      <div class="brand sidebar-brand">
        <span class="brand-dot" aria-hidden="true"></span>
        <span class="brand-name">青梅</span>
        <span class="brand-badge">控制台</span>
      </div>
      <p class="nav-heading">菜单</p>
      <nav ref="navRef" class="nav" aria-label="主导航">
        <router-link
          v-for="item in NAV"
          :key="item.path"
          :to="item.path"
          class="nav-link"
          :title="item.hint"
          @click="closeDrawer()"
        >
          {{ item.title }}
        </router-link>
      </nav>
      <div class="sidebar-foot">
        <span class="status-pill" :data-state="session.status" role="status" aria-live="polite">
          <span class="status-dot" aria-hidden="true"></span>
          <span class="status-text">{{ session.statusText }}</span>
        </span>
      </div>
    </aside>

    <div class="drawer-scrim" aria-hidden="true" @click="closeDrawer()"></div>

    <main class="main">
      <router-view v-slot="{ Component }">
        <keep-alive include="ChatView">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </main>

    <LoginModal v-if="loginOpen" @done="finishBoot" />
    <UpdatePrompt v-if="update" :latest="update" @dismiss="update = null" />
  </div>
</template>
