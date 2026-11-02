/**
 * @qingmei/qm-approval —— 审批队列的 HTTP 面与 SSE 桥。
 *
 * `GET  /api/v1/approvals?status=pending` 看有哪些等人确认的动作
 * `POST /api/v1/approvals/decide` { id, allow, reason? } 批准/拒绝
 *
 * 请求来源有两处：permission 判定 `ask`（MCP 工具调用）、以及 harness 发来的
 * ACP `session/request_permission`（子 agent 要执行敏感操作）。两边都 `wait()` 同一个队列。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  type ApprovalRequest,
  type ApprovalService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
} from '@qingmei/core'

export const name = 'qm-approval'
export const inject = ['approval', 'gateway']

export function apply(ctx: Context): void {
  const approval = ctx.reflect.get('approval', false) as ApprovalService | undefined
  if (!approval) throw new Error('[qm-approval] 缺少 approval 服务')
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!gateway) throw new Error('[qm-approval] 缺少 gateway 服务')

  // 审批状态推给 SSE：Web 面板不需要轮询
  for (const [event, type] of [
    [EVENTS.approvalRequested, 'approval-requested'],
    [EVENTS.approvalDecided, 'approval-decided'],
  ] as const) {
    ctx.events.on(event, (request: ApprovalRequest) => {
      gateway.publish({ type, data: request })
    })
  }

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/approvals',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const raw = (req.query.status ?? '').trim()
        const status = raw === 'pending' || raw === 'allowed' || raw === 'denied' ? raw : undefined
        res.status(200).send({ ok: true, items: await approval.list(status) })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/approvals/decide',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 不能为空' })
          return
        }
        if (typeof body.allow !== 'boolean') {
          res.status(400).send({ ok: false, error: 'allow 必须是布尔值' })
          return
        }
        const decided = await approval.decide(id, {
          allow: body.allow,
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        })
        if (!decided) {
          res.status(404).send({ ok: false, error: '没有这条审批' })
          return
        }
        res.status(200).send({ ok: true, request: decided })
      },
    }),
  )
}

export const defaultExport = { name, inject, apply }
