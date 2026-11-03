/**
 * @qingmei/qm-history —— qm_message / qm_turn 的唯一写入方。
 *
 * 所有消息都从事件落库：
 * - `qm/turn/start` → 用户消息（排队轮到这条消息时写，保证和助手消息的顺序一致）
 * - `qm/outbound`   → 助手/主动消息（渠道投递成功后由 service-channel 发出）
 * - `qm/turn/end`   → qm_turn 一行（回合结果、耗时）
 *
 * 字段按 docs/04 的表设计：`direction` / `blocks_json` / `trace_id` / `platform_message_id`。
 * `text` 是给现有读取方（qm-agent、Web）的冗余列，来源是 blocks。
 * 幂等：同一 session + platform_message_id 只写一次，平台重投不会多出一条。
 *
 * 用户消息不在 qm/inbound 时写：两条消息连发时，入站顺序会把「第二条用户消息」
 * 排到「第一条的回复」前面。等回合真正开始再写，历史顺序才是对话顺序。
 *
 * 其它插件不再直接写 qm_message：新增主动消息（提醒、日报、告警）只要走
 * ChannelService.send，历史里就自动有记录。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  textOf,
  uid,
  type Block,
  type OutboundRecord,
  type Row,
  type StoreService,
  type TurnEnd,
  type TurnStart,
} from '@qingmei/core'

export const name = 'qm-history'
export const inject = ['store']

const MESSAGE_COLLECTION = 'qm_message'
const TURN_COLLECTION = 'qm_turn'

/** qm_message 的行形状（docs/04 §4；P1 用通用 JSON 表存，没有真实索引） */
interface StoredMessage extends Row {
  session_id: string
  role: 'user' | 'assistant'
  direction: 'in' | 'out'
  blocks_json: string
  /** 冗余列：给 qm-agent / Web 直接读 */
  text: string
  trace_id: string | null
  platform_message_id?: string
  created_at: number
}

interface StoredTurn extends Row {
  session_id: string
  status: 'ok' | 'partial' | 'failed' | 'aborted'
  steps: number
  tokens_in: number | null
  tokens_out: number | null
  latency_ms: number | null
  error_code: string | null
  created_at: number
}

export function apply(ctx: Context): void {
  const store = ctx.reflect.get('store', false) as StoreService | undefined
  if (!store) throw new Error('[qm-history] 缺少 store 服务')
  const collection = store.collection<StoredMessage>(MESSAGE_COLLECTION)
  const turns = store.collection<StoredTurn>(TURN_COLLECTION)

  // 二级索引：消息按会话取时间线、平台重投按 (session_id, platform_message_id) 唯一
  void (async () => {
    try {
      await store.ensureIndex('qm_message', ['session_id', 'created_at'])
      await store.ensureIndex('qm_message', ['session_id', 'platform_message_id'], {
        unique: true,
        where: "json_extract(json, '$.platform_message_id') IS NOT NULL",
      })
      await store.ensureIndex('qm_turn', ['session_id'])
    } catch (error) {
      ctx.logger.warn(`[qm-history] 建索引失败：${messageOf(error)}`)
    }
  })()
  // 写入串行化：幂等是「先查再插」，并发跑会两个都插进去
  let writeChain: Promise<void> = Promise.resolve()
  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = writeChain.then(task, task)
    writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // 同一毫秒内的两条消息也要有先后：created_at 用进程内单调时钟
  let lastCreatedAt = 0
  function nextCreatedAt(): number {
    const now = Date.now()
    lastCreatedAt = Math.max(now, lastCreatedAt + 1)
    return lastCreatedAt
  }

  async function append(input: {
    sessionId: string
    role: StoredMessage['role']
    direction: StoredMessage['direction']
    blocks: Block[]
    createdAt: number
    platformMessageId?: string
    traceId?: string
  }): Promise<void> {
    const text = textOf(input.blocks)
    if (!text) return
    // 平台重投：同一个 platform_message_id 只写一次
    if (input.platformMessageId) {
      const existing = await collection.find({
        where: { session_id: input.sessionId, platform_message_id: input.platformMessageId },
        limit: 1,
      })
      if (existing.length > 0) return
    }
    try {
      await collection.insert({
        id: uid('msg'),
        session_id: input.sessionId,
        role: input.role,
        direction: input.direction,
        blocks_json: JSON.stringify(input.blocks),
        text,
        trace_id: input.traceId ?? null,
        ...(input.platformMessageId ? { platform_message_id: input.platformMessageId } : {}),
        created_at: input.createdAt,
      })
    } catch (error) {
      // 并发下唯一索引可能先一步拒绝：视作幂等成功
      if (input.platformMessageId && isUniqueViolation(error)) return
      throw error
    }
  }

  // 用户消息：回合开始时写。没有谁等它写完，异步处理；失败只记日志，不能打断回合
  ctx.events.on(EVENTS.turnStart, (start: TurnStart) => {
    const createdAt = nextCreatedAt()
    void enqueue(() =>
      append({
        sessionId: start.sessionId,
        role: 'user',
        direction: 'in',
        blocks: start.message.blocks,
        createdAt,
        platformMessageId: start.message.platformMessageId,
        traceId: start.traceId,
      }),
    ).catch((error: unknown) => {
      ctx.logger.warn(`[qm-history] 用户消息落库失败：${messageOf(error)}`)
    })
  })

  // 出站消息用 async 监听器：service-channel 用 parallel 等它写完再返回
  ctx.events.on(EVENTS.outbound, async (outbound: OutboundRecord) => {
    // 编辑已发消息（如审批卡片点完变「已处理」）：更新原行，不新增
    if (outbound.editTarget) {
      await enqueue(async () => {
        const sessionId = `s_${outbound.conversationId}`
        const rows = await collection.find({ session_id: sessionId, platform_message_id: outbound.editTarget })
        const row = rows[0]
        if (!row) return
        await collection.update(row.id, {
          blocks_json: JSON.stringify(outbound.blocks),
          text: textOf(outbound.blocks),
        })
      })
      return
    }

    await enqueue(() => append({
      sessionId: `s_${outbound.conversationId}`,
      role: 'assistant',
      direction: 'out',
      blocks: outbound.blocks,
      createdAt: nextCreatedAt(),
      ...(outbound.platformMessageId ? { platformMessageId: outbound.platformMessageId } : {}),
      ...(outbound.traceId ? { traceId: outbound.traceId } : {}),
    }))
  })

  // 回合账本：结束时写一行；同一个 traceId 只写一次
  ctx.events.on(EVENTS.turnEnd, (end: TurnEnd) => {
    void enqueue(async () => {
      if (await turns.get(end.traceId)) return
      const latency = typeof end.latencyMs === 'number' ? Math.max(0, end.latencyMs) : null
      await turns.insert({
        id: end.traceId,
        session_id: end.sessionId,
        status: end.ok ? 'ok' : 'failed',
        steps: typeof end.steps === 'number' ? end.steps : 0,
        tokens_in: typeof end.tokensIn === 'number' ? end.tokensIn : null,
        tokens_out: typeof end.tokensOut === 'number' ? end.tokensOut : null,
        latency_ms: latency,
        error_code: null,
        created_at: nextCreatedAt() - (latency ?? 0),
      })
    }).catch((error: unknown) => {
      ctx.logger.warn(`[qm-history] 回合落库失败：${messageOf(error)}`)
    })
  })
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error && /UNIQUE constraint failed/i.test(current.message)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const defaultExport = { name, inject, apply }
