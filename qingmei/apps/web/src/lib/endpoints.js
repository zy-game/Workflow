// 接口清单：纯数据模块，不碰 window，契约测试直接 import 它。
// 前缀 `.` 表示与页面同源；Capacitor 壳通过 window.__QM_SERVER_URL 换成绝对地址。
export const ENDPOINTS = {
  health: './healthz',
  login: './api/v1/login',
  session: './api/v1/session',
  events: './api/v1/events',
  messages: './api/v1/messages',
  memoryFacts: './api/v1/memory/facts',
  memoryStats: './api/v1/memory/stats',
  memoryConsolidate: './api/v1/memory/consolidate',
  memoryCandidates: './api/v1/memory/candidates',
  memoryCandidateDecide: './api/v1/memory/candidates/decide',
  memoryCandidateRollback: './api/v1/memory/candidates/rollback',
  memoryCandidateReopen: './api/v1/memory/candidates/reopen',
  memoryProfile: './api/v1/memory/profile',
  conceptProposals: './api/v1/memory/concepts/proposals',
  conceptEvaluate: './api/v1/memory/concepts/evaluate',
  conceptApply: './api/v1/memory/concepts/apply',
  conceptRollback: './api/v1/memory/concepts/rollback',
  conceptChanges: './api/v1/memory/concepts/changes',
  conceptRollbackBatch: './api/v1/memory/concepts/rollback-batch',
  schedules: './api/v1/schedules',
  tasks: './api/v1/tasks',
  devices: './api/v1/devices',
  deviceTasks: './api/v1/devices/tasks',
  approvals: './api/v1/approvals',
  approvalDecide: './api/v1/approvals/decide',
  autonomy: './api/v1/autonomy',
  autonomyTick: './api/v1/autonomy/tick',
  autonomyTrust: './api/v1/autonomy/trust',
  autonomyDigest: './api/v1/autonomy/digest',
  autonomyComplaint: './api/v1/autonomy/complaint',
  autonomyRollback: './api/v1/autonomy/rollback',
  conversations: './api/v1/conversations',
  conversationsConfigure: './api/v1/conversations/configure',
  conversationSuggestions: './api/v1/conversations/suggestions',
  conversationPreview: './api/v1/conversations/preview',
  conversationHistory: './api/v1/conversations/history',
  conversationRollback: './api/v1/conversations/rollback',
  conversationSuggestionAccept: './api/v1/conversations/suggestions/accept',
  conversationSuggestionDismiss: './api/v1/conversations/suggestions/dismiss',
  incidents: './api/v1/incidents',
  incidentDispatch: './api/v1/incidents/dispatch',
  incidentRollback: './api/v1/incidents/rollback',
  incidentResolve: './api/v1/incidents/resolve',
  review: './api/v1/review',
  audit: './api/v1/audit',
  persona: './api/v1/persona',
  personaHistory: './api/v1/persona/history',
  personaApply: './api/v1/persona/apply',
  personaRollback: './api/v1/persona/rollback',
  skillsHistory: './api/v1/skills/history',
  skillsRollback: './api/v1/skills/rollback',
  reviewCards: './api/v1/review/cards',
  reviewCardScore: './api/v1/review/cards/score',
  reviewRun: './api/v1/review/run',
  reviewScore: './api/v1/review/score',
  reviewProposals: './api/v1/review/proposals',
  reviewProposalApply: './api/v1/review/proposals/apply',
  reviewProposalDismiss: './api/v1/review/proposals/dismiss',
  cost: './api/v1/cost',
  costRefresh: './api/v1/cost/refresh',
  // 账号运维 · 内容层（docs/18 §10）
}

export function resolveEndpoint(path) {
  if (typeof path !== 'string' || !path.startsWith('./')) return path
  const base =
    typeof window !== 'undefined' ? String(window.__QM_SERVER_URL || '').replace(/\/+$/, '') : ''
  return base ? base + path.slice(1) : path
}



