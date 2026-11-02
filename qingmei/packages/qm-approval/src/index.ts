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
  textOf,
  type ActionEvent,
  type ApprovalRequest,
  type ApprovalService,
  type GatewayRequest,
  type GatewayResponse,
  type ChannelId,
  type ChannelService,
  type GatewayService,
  type InboundMessage,
  type Row,
  type StoreService,
} from '@qingmei/core'

interface ApprovalPush extends Row {
  channels: string[]
}

interface ChannelTarget extends Row {
  conversationId: string
  updatedAt: number
}

export const name = 'qm-approval'
export const inject = ['approval', 'gateway', 'store']

export function apply(ctx: Context): void {
  const approval = ctx.reflect.get('approval', false) as ApprovalService | undefined
  if (!approval) throw new Error('[qm-approval] 缺少 approval 服务')
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!gateway) throw new Error('[qm-approval] 缺少 gateway 服务')
  const store = ctx.reflect.get('store', false) as StoreService | undefined
  if (!store) throw new Error('[qm-approval] 缺少 store 服务')
  const targets = store.collection<ChannelTarget>('qm_channel_target')
  const pushes = store.collection<ApprovalPush>('qm_approval_push')

  // 渠道里回「批准/拒绝」直接处理最早的一条待确认；没有待确认时静默忽略
  const channel = ctx.reflect.get('channel', false) as ChannelService | undefined
  ctx.events.on(EVENTS.inbound, (message: InboundMessage) => {
    void rememberTarget(message).catch(() => undefined)
    const text = textOf(message.blocks).trim()
    const allow = /^(批准|同意|允许|approve|allow)[!！。.,，\s]*$/i.test(text)
    const deny = /^(拒绝|不同意|deny|reject)[!！。.,，\s]*$/i.test(text)
    if (!allow && !deny) return
    // 控制指令：qm-agent 看到 handledBy 会跳过这一轮，避免再回一句
    message.handledBy = 'approval'
    void decideFromChannel(allow, message).catch((error: unknown) => {
      ctx.logger.warn(`[qm-approval] 渠道审批失败：${messageOf(error)}`)
    })
  })

  /** 记住每个渠道最近一次会话，审批请求推到这里 */
  async function rememberTarget(message: InboundMessage): Promise<void> {
    if (message.channel === 'web') return
    const existing = await targets.get(message.channel)
    const updatedAt = Date.now()
    if (existing) await targets.update(existing.id, { conversationId: message.conversation.id, updatedAt })
    else await targets.insert({ id: message.channel, conversationId: message.conversation.id, updatedAt })
  }

  /** 审批一创建就推到最近的渠道会话；Web 侧靠任务面板，不重复发 */
  async function notifyApproval(request: ApprovalRequest): Promise<void> {
    const rows = await targets.find({})
    if (!channel || rows.length === 0) return
    const pending = await approval.list('pending')
    const extra = pending.length > 1 ? `（还有 ${pending.length - 1} 条待确认）` : ''
    for (const row of rows) {
      await channel
        .send({
          channel: row.id as ChannelId,
          conversationId: row.conversationId,
          blocks: [
            { type: 'text', text: `🔐 待确认：${request.prompt}\n回「批准」或「拒绝」即可${extra}` },
            {
              type: 'actions',
              buttons: [
                { id: `approval:allow:${request.id}`, label: '同意', style: 'primary' },
                { id: `approval:deny:${request.id}`, label: '拒绝', style: 'danger' },
              ],
            },
          ],
        })
        .catch(() => undefined)
    }
    // 记下这条审批推到了哪些渠道，Web 面板要显示
    const channels = rows.map((row) => row.id)
    const existing = await pushes.get(request.id)
    if (existing) await pushes.update(existing.id, { channels })
    else await pushes.insert({ id: request.id, channels })
  }

  ctx.events.on(EVENTS.approvalRequested, (request: ApprovalRequest) => {
    void notifyApproval(request).catch((error: unknown) => {
      ctx.logger.warn(`[qm-approval] 审批推送失败：${messageOf(error)}`)
    })
  })
  // 卡片按钮：approval:allow:<id> / approval:deny:<id>
  ctx.events.on(EVENTS.action, (action: ActionEvent) => {
    void handleAction(action).catch((error: unknown) => {
      ctx.logger.warn(`[qm-approval] 按钮审批失败：${messageOf(error)}`)
    })
  })

  async function handleAction(action: ActionEvent): Promise<void> {
    const match = /^approval:(allow|deny):(.+)$/.exec(action.actionId)
    if (!match) return
    const allow = match[1] === 'allow'
    const request = await approval.get(match[2]!)
    if (!request || request.status !== 'pending') return

    const decided = await approval.decide(request.id, {
      allow,
      reason: `来自 ${action.channel} 的按钮`,
    })
    if (!decided || !channel) return
    await channel
      .send({
        channel: action.channel,
        conversationId: action.conversationId,
        blocks: [{ type: 'text', text: `${allow ? '✅ 已批准' : '⛔ 已拒绝'}：${request.prompt}` }],
      })
      .catch(() => undefined)
  }
  async function decideFromChannel(allow: boolean, message: InboundMessage): Promise<void> {
    const pending = (await approval.list('pending')).slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    const target = pending[0]
    if (!target) return

    const decided = await approval.decide(target.id, {
      allow,
      reason: `来自 ${message.channel} 的消息`,
    })
    if (!decided || !channel) return
    const remaining = pending.length - 1
    const text = `${allow ? '✅ 已批准' : '⛔ 已拒绝'}：${target.prompt}${remaining > 0 ? `（还有 ${remaining} 条待确认）` : ''}`
    await channel
      .send({
        channel: message.channel,
        conversationId: message.conversation.id,
        blocks: [{ type: 'text', text }],
      })
      .catch(() => undefined)
  }
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
        const items = await approval.list(status)
        const pushRows = await pushes.find({})
        const byId = new Map(pushRows.map((row) => [row.id, row.channels]))
        res.status(200).send({
          ok: true,
          items: items.map((item) => ({ ...item, notifiedTo: byId.get(item.id) ?? [] })),
        })
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
