import { reactive } from 'vue'

export const TOKEN_KEY = 'qm.token'

export const session = reactive({
  token: '',
  cookieAuth: false,
  authReady: false,
  /** connecting | online | offline | error */
  status: 'connecting',
  statusText: '连接中…',
  reconnectAttempt: 0,
})

const STATUS_TEXT = {
  connecting: '连接中…',
  online: '在线',
  offline: '离线',
  error: '需要令牌',
}

export function loadToken() {
  try {
    return (
      sessionStorage.getItem(TOKEN_KEY) ||
      (window.__QM_PERSIST_TOKEN__ ? localStorage.getItem(TOKEN_KEY) : '') ||
      ''
    )
  } catch {
    return ''
  }
}

export function saveToken(token) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
    if (window.__QM_PERSIST_TOKEN__) localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // 隐私模式禁用存储时，令牌只在本次页面生命周期内有效
  }
}

export function readUrlToken() {
  let url
  try {
    url = new URL(location.href)
  } catch {
    return ''
  }
  // hash 路由下 token 也可能出现在 query 里（location.search），URL 对象两种都覆盖
  const token = (url.searchParams.get('token') || '').trim()
  if (!token) return ''
  saveToken(token)
  // 令牌不留在地址栏与历史记录里；刷新时从 sessionStorage 取回
  url.searchParams.delete('token')
  try {
    history.replaceState(history.state, '', url.href)
  } catch {
    // file:// 等环境不允许改历史，忽略即可
  }
  return token
}

export function hasAuth() {
  return Boolean(session.token || session.cookieAuth)
}

export function authHeaders(extra = {}) {
  const next = { ...extra }
  if (session.token) next.Authorization = `Bearer ${session.token}`
  return next
}

export function setStatus(kind, text) {
  session.status = kind
  session.statusText = text || STATUS_TEXT[kind] || ''
}
