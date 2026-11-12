/**
 * 首次连接探测：给「测试连接」按钮用。
 *
 * 只做两件事：/healthz 证明服务活着，/api/v1/session 带 Bearer 证明令牌有效。
 * 放在主进程里调（不受渲染进程 CORS 限制），纯逻辑部分可注入 fetch 做单测。
 */

/**
 * @returns {Promise<{ ok: boolean, tokenValid?: boolean, channels?: {id:string,online:boolean}[], agent?: number, uptime?: number, error?: string }>}
 */
async function probeServer({ serverUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 6_000 } = {}) {
  const base = String(serverUrl ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/\S+$/i.test(base)) return { ok: false, error: '服务器地址必须是 http(s) URL' }

  const call = (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })

  let health
  try {
    health = await call(`${base}/healthz`)
  } catch (error) {
    return { ok: false, error: `连不上服务器：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!health.ok) return { ok: false, error: `服务返回 ${health.status}` }
  const info = await health.json().catch(() => ({}))

  let tokenValid = false
  try {
    const session = await call(`${base}/api/v1/session`, {
      headers: { Authorization: `Bearer ${String(token ?? '').trim()}` },
    })
    tokenValid = session.ok === true
  } catch {
    tokenValid = false
  }

  return {
    ok: true,
    tokenValid,
    channels: Array.isArray(info.channels) ? info.channels : [],
    agent: Number(info.agent) || 0,
    uptime: Number(info.uptime) || 0,
  }
}

/** 把探测结果翻成一句人话，给 UI 直接用。 */
function describeProbe(result) {
  if (!result?.ok) return result?.error ?? '连接失败'
  if (!result.tokenValid) return '服务在线，但令牌不对（检查 QM_TOKEN）'
  const online = (result.channels ?? []).filter((channel) => channel.online).map((channel) => channel.id)
  if (online.length === 0) return '服务在线、令牌有效，但没有任何渠道在线'
  return `连接正常：${online.join(' / ')} 在线`
}

module.exports = { probeServer, describeProbe }
