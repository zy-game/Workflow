export const TASK_STATUS_TEXT = {
  queued: '排队中',
  running: '执行中',
  needs_approval: '等确认',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

export const AUTONOMY_EXEC_TEXT = {
  executed: '已执行',
  suggested: '已发建议',
  skipped: '跳过',
  failed: '失败',
}

export const INCIDENT_STATUS_TEXT = {
  open: '待处理',
  proposed: '待处理',
  acknowledged: '已派诊断',
  fused: '已熔断',
  resolved: '已解决',
}

export const CONVERSATION_STATUS_TEXT = {
  pending: '待配置',
  configured: '已配置',
  muted: '静音',
  blocked: '已拉黑',
}

export const CONTENT_STATUS_TEXT = {
  idea: '想法',
  drafting: '起草中',
  drafted: '草稿',
  reviewing: '待人审',
  approved: '已批准',
  published: '已发布',
  archived: '已归档',
  rejected: '已驳回',
}

export const VARIANT_STATUS_TEXT = {
  pending: '待生成',
  rendering: '生成中',
  ready: '已就绪',
  scheduled: '已排期',
  publishing: '发布中',
  live: '已上线',
  failed: '失败',
}

export const PLATFORM_TEXT = {
  blog: '博客',
  weibo: '微博',
  bilibili: 'B站',
  zhihu: '知乎',
}

/** 按日程自己的时区显示时间；时区参数不可用时退回本机时区 */
export function formatWhen(iso, timezone) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }
  try {
    return new Intl.DateTimeFormat('zh-CN', timezone ? { ...options, timeZone: timezone } : options).format(date)
  } catch {
    return new Intl.DateTimeFormat('zh-CN', options).format(date)
  }
}

export function humanGap(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} 小时`
  return `${Math.round(ms / 86_400_000)} 天`
}

export function ruleOf(item) {
  if (typeof item?.cron === 'string' && item.cron) {
    return `cron ${item.cron}${item.timezone ? ` · ${item.timezone}` : ''}`
  }
  if (Number.isFinite(item?.everyMs) && item.everyMs > 0) return `每 ${humanGap(item.everyMs)}`
  return '一次性'
}

/** datetime-local 需要本地时区的 YYYY-MM-DDTHH:mm（不带秒） */
export function localDateTimeValue(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
