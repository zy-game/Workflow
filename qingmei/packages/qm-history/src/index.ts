/**
 * @qingmei/qm-history —— qm_message 的唯一写入方。
 *
 * 所有消息都从事件落库：
 * - `qm/turn/start` → 用户消息（排队轮到这条消息时写，保证和助手消息的顺序一致）
 * - `qm/outbound`   → 助手消息（渠道投递成功后由 service-channel 发出）
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
  type OutboundRecord,
  type Row,
  type StoreService,
  type TurnStart,
} from '@qingmei/core'

export const name = 'qm-history'
export const inject = ['store']

const MESSAGE_COLLECTION = 'qm_message'

/** qm_message 的 P1 行形状（docs/04 的完整字段在 P1 里只保留对话所需的最小集） */
interface StoredMessage extends Row {
  session_id: string
  role: 'user' | 'assistant'
  text: string
  /** 入站消息的平台 id：qm-agent 用它把「本轮消息」从历史里摘出去 */
  platform_message_id?: string
  created_at: number
}

export function apply(ctx: Context): void {
  const store = ctx.reflect.get('store', false) as StoreService | undefined
  if (!store) throw new Error('[qm-history] 缺少 store 服务')
  const collection = store.collection<StoredMessage>(MESSAGE_COLLECTION)

  /**
   * 本插件写入的时间戳单调递增：两条消息落在同一毫秒时排序仍然稳定。
   * 时间戳在收到事件时就算好（而不是等 insert 执行），异步落库才不会打乱事件顺序。
   */
  let lastCreatedAt = 0
  function nextCreatedAt(): number {
    lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1)
    return lastCreatedAt
  }

  async function append(
    conversationId: string,
    role: StoredMessage['role'],
    text: string,
    createdAt: number,
    platformMessageId?: string,
  ): Promise<void> {
    await collection.insert({
      id: uid('msg'),
      session_id: `s_${conversationId}`,
      role,
      text,
      ...(platformMessageId ? { platform_message_id: platformMessageId } : {}),
      created_at: createdAt,
    })
  }

  // 用户消息：回合开始时写。没有谁等它写完，异步处理；失败只记日志，不能打断回合
  ctx.events.on(EVENTS.turnStart, (start: TurnStart) => {
    const text = textOf(start.message.blocks)
    if (!text) return
    const createdAt = nextCreatedAt()
    void append(start.message.conversation.id, 'user', text, createdAt, start.message.platformMessageId).catch(
      (error: unknown) => {
        ctx.logger.warn(`[qm-history] 用户消息落库失败：${messageOf(error)}`)
      },
    )
  })

  // 出站消息用 async 监听器：service-channel 用 parallel 等它写完再返回
  ctx.events.on(EVENTS.outbound, async (outbound: OutboundRecord) => {
    const text = textOf(outbound.blocks)
    if (!text) return
    await append(outbound.conversationId, 'assistant', text, nextCreatedAt())
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const defaultExport = { name, inject, apply }
