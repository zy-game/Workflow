/**
 * @qingmei/qm-audit —— 审计的只读 HTTP 面。
 *
 * `GET /api/v1/audit?limit=20&action=&actor=&decision=allow|deny&since=<ISO>`
 *
 * 审计是只追加的（docs/04），这里不提供写/删入口；给后台与排障用。
 */
import type { Context } from 'cordis'
import { SqliteAudit } from './store.ts'
import {
  type AuditEntry,
  type AuditService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
} from '@qingmei/core'

export const name = 'qm-audit'
export const inject = ['store', 'gateway']

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 200

export function apply(ctx: Context): void {
  const audit = new SqliteAudit(ctx)
  const gateway = ctx.gateway

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/audit',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const rawDecision = (req.query.decision ?? '').trim()
        if (rawDecision && rawDecision !== 'allow' && rawDecision !== 'deny') {
          res.status(400).send({ ok: false, error: 'decision 只能是 allow 或 deny' })
          return
        }
        const rawSince = (req.query.since ?? '').trim()
        let since: Date | undefined
        if (rawSince) {
          const parsed = Date.parse(rawSince)
          if (!Number.isFinite(parsed)) {
            res.status(400).send({ ok: false, error: 'since 必须是 ISO 时间' })
            return
          }
          since = new Date(parsed)
        }
        const requested = Number(req.query.limit ?? DEFAULT_LIMIT)
        const limit = Number.isFinite(requested) ? Math.min(MAX_LIMIT, Math.max(1, requested)) : DEFAULT_LIMIT

        const items: AuditEntry[] = await audit.query({
          limit,
          ...(since ? { since } : {}),
          ...(req.query.action ? { action: req.query.action.trim() } : {}),
          ...(req.query.actor ? { actorId: req.query.actor.trim() } : {}),
          ...(req.query.conversationId ? { conversationId: req.query.conversationId.trim() } : {}),
          ...(rawDecision === 'allow' || rawDecision === 'deny' ? { decision: rawDecision } : {}),
        })
        res.status(200).send({ ok: true, items })
      },
    }),
  )
}

export const defaultExport = { name, inject, apply }
