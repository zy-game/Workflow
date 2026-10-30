/**
 * @qingmei/qm-reminder —— 把到点的日程投递到用户所在的渠道。
 *
 * 只负责「投递」：落库由 qm-history 订阅 qm/outbound 完成，
 * 所以提醒不经过 qm-agent 的回合，也能出现在会话历史里。
 */
import type { Context } from 'cordis'
import { EVENTS, type Scheduled } from '@qingmei/core'

export const name = 'qm-reminder'
export const inject = ['channel']

export function apply(ctx: Context): void {
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
      if (!result.ok) ctx.logger.warn(`[qm-reminder] 投递失败：${result.error ?? '未知'}`)
    } catch (error) {
      ctx.logger.warn(`[qm-reminder] 投递异常：${messageOf(error)}`)
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const defaultExport = { name, inject, apply }
