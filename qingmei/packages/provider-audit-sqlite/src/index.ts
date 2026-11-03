/**
 * @qingmei/provider-audit-sqlite —— 只追加的审计流水，落在 store 的 `qm_audit` 集合。
 *
 * 契约（docs/02）只有 append / query：没有 update、没有 delete，
 * 清理只能靠时间分区归档。detail 只放已脱敏的摘要。
 */
import type { Context } from 'cordis'
import { AuditService, uid, type AuditEntry, type ChannelId, type Row, type StoreService } from '@qingmei/core'

export const name = 'provider-audit-sqlite'
export const inject = ['store']

const COLLECTION = 'qm_audit'
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

interface AuditRow extends Row {
  at: number
  actor_id: string | null
  channel: string
  conversation_id?: string | null
  action: string
  target: string | null
  decision: string | null
  detail_json: string | null
  trace_id: string
}

export class SqliteAudit extends AuditService {
  private readonly collection

  constructor(ctx: Context) {
    super(ctx)
    const store = ctx.reflect.get('store', false) as StoreService | undefined
    if (!store) throw new Error('[provider-audit-sqlite] 缺少 store 服务')
    this.collection = store.collection<AuditRow>(COLLECTION)
  }

  async append(entry: AuditEntry): Promise<void> {
    await this.collection.insert({
      id: uid('aud'),
      at: entry.at.getTime(),
      actor_id: entry.actorId ?? null,
      channel: entry.channel ?? null,
      conversation_id: entry.conversationId ?? null,
      action: entry.action,
      target: entry.target ?? null,
      decision: entry.decision ?? null,
      detail_json: entry.detail ? JSON.stringify(entry.detail) : null,
      trace_id: entry.traceId,
    })
  }

  async query(q: {
    since?: Date
    actorId?: string
    conversationId?: string
    action?: string
    decision?: 'allow' | 'deny'
    limit?: number
  } = {}): Promise<AuditEntry[]> {
    const rows = await this.collection.find()
    const since = q.since?.getTime()
    const filtered = rows
      .filter((row) => (since === undefined ? true : row.at >= since))
      .filter((row) => (q.actorId === undefined ? true : row.actor_id === q.actorId))
      .filter((row) => (q.conversationId === undefined ? true : row.conversation_id === q.conversationId))
      .filter((row) => (q.action === undefined ? true : row.action === q.action))
      .filter((row) => (q.decision === undefined ? true : row.decision === q.decision))
      .sort((a, b) => b.at - a.at)

    const limit = Math.min(MAX_LIMIT, Math.max(1, q.limit ?? DEFAULT_LIMIT))
    return filtered.slice(0, limit).map(toEntry)
  }
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    at: new Date(row.at),
    actorId: row.actor_id ?? '',
    channel: (row.channel ?? 'web') as ChannelId,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    action: row.action,
    ...(row.target ? { target: row.target } : {}),
    ...(row.decision === 'allow' || row.decision === 'deny' ? { decision: row.decision } : {}),
    ...(row.detail_json ? { detail: parseDetail(row.detail_json) } : {}),
    traceId: row.trace_id,
  }
}

function parseDetail(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { raw }
  } catch {
    return { raw }
  }
}

export function apply(ctx: Context): void {
  ctx.plugin(SqliteAudit)
}

export const defaultExport = { name, inject, apply }
