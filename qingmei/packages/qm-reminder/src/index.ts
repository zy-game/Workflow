/**
 * @qingmei/qm-reminder —— 把到点的日程投递到用户所在的渠道，并写入会话历史。
 *
 * 注意：这里是主动消息，不经过 qm-agent 的回合，所以必须自己落库，
 * 否则刷新后历史里看不到提醒。后续所有主动消息都应走同一个 helper。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  uid,
  type ChannelService,
  type Row,
  type Scheduled,
  type StoreService,
} from '@qingmei/core'

export const name = 'qm-reminder'
export const inject = ['channel', 'store']

interface StoredMessage extends Row {
  session_id: string
  role: 'user' | 'assistant'
  text: string
  created_at: number
}

export function apply(ctx: Context): void {
  const store = ctx.reflect.get('store', false) as StoreService | undefined
  const messages = store?.collection<StoredMessage>('qm_message')

  ctx.events.on(EVENTS.scheduleDue, (item: Scheduled) => {
    void deliver(item)
  })

  async function deliver(item: Scheduled): Promise<void> {
    const text = `⏰ 提醒：${item.text}`
    try {
      const result = await ctx.channel.send({
        channel: item.channel,
        conversationId: item.conversationId,
        blocks: [{ type: 'text', text }],
      })
      if (!result.ok) {
        ctx.logger.warn(`[qm-reminder] 投递失败：${result.error ?? '未知'}`)
        return
      }
      // 与 qm-agent 的 session 规则保持一致：s_<conversationId>
      await messages?.insert({
        id: uid('msg'),
        session_id: `s_${item.conversationId}`,
        role: 'assistant',
        text,
        created_at: Date.now(),
      })
    } catch (error) {
      ctx.logger.warn(`[qm-reminder] 投递异常：${messageOf(error)}`)
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const defaultExport = { name, inject, apply }
