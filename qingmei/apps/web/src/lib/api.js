import { resolveEndpoint } from './endpoints.js'
import { authHeaders } from './session.js'

export class ApiError extends Error {
  constructor(message, status = 0, detail = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

function buildUrl(path, query) {
  let url = resolveEndpoint(path)
  if (!query) return url
  const base = typeof location !== 'undefined' ? location.href : 'http://localhost/'
  const parsed = new URL(url, base)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    parsed.searchParams.set(key, String(value))
  }
  return parsed.href
}

/** 统一的 fetch 入口：鉴权头、JSON、同源缓存策略都在这里 */
export async function request(path, options = {}) {
  const { method = 'GET', body, query, headers = {}, signal, credentials } = options
  const init = {
    method,
    headers: authHeaders({
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    }),
    cache: 'no-store',
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  if (signal) init.signal = signal
  if (credentials) init.credentials = credentials
  return fetch(buildUrl(path, query), init)
}

async function detailOf(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** GET 一类：读 JSON，失败抛 ApiError（带后端 error 文案） */
export async function apiJson(path, options = {}) {
  const res = await request(path, options)
  const detail = await detailOf(res)
  if (!res.ok) {
    const message =
      (detail && (detail.error || detail.message)) ||
      (res.status === 401 || res.status === 403 ? '令牌无效或已过期' : `请求失败（HTTP ${res.status}）`)
    throw new ApiError(message, res.status, detail)
  }
  return detail
}

/** 写一类：只关心成功/失败，成功返回后端 JSON */
export async function apiSend(path, options = {}) {
  return apiJson(path, { ...options, method: options.method ?? 'POST' })
}

export function describeFailure(res) {
  if (res.status === 401 || res.status === 403) {
    return '令牌无效或已过期，请用带 ?token= 的新链接打开'
  }
  return `发送失败（HTTP ${res.status}）`
}
