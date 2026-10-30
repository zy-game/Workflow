/**
 * @qingmei/channel-web —— Web 渠道适配器。
 *
 * Web 没有独立连接：消息由 host-gateway 的 HTTP/SSE 端点进出，
 * 所以 send() 只把信封投递到 gateway 的事件流，由前端渲染。
 */
import {
  uid,
  type ChannelAdapter,
  type ChannelCapabilities,
  type OutboundEnvelope,
  type SendResult,
} from '@qingmei/core'
import type { ChannelService, GatewayService } from '@qingmei/core'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    channel: ChannelService
    gateway: GatewayService
  }
}

export interface Config {
  /** Web 渠道不需要额外配置；保留空接口以便组合根统一展开 config。 */
}

export const capabilities: ChannelCapabilities = {
  markdown: true,
  card: true,
  button: true,
  image: true,
  voice: true,
  file: true,
  edit: true,
  thread: true,
  maxTextLength: 8000,
}

export function createWebAdapter(ctx: Context): ChannelAdapter {
  return {
    id: 'web',
    capabilities,
    // 连接由 host-gateway 持有，适配器本身没有需要建立或释放的资源。
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async send(envelope: OutboundEnvelope): Promise<SendResult> {
      const platformMessageId = uid('msg')
      ctx.gateway.publish({ type: 'assistant', data: envelope })
      return { ok: true, platformMessageId }
    },
  }
}

export const name = 'channel-web'
export const inject = ['channel', 'gateway']

export const apply = (ctx: Context, _config: Config = {}): void => {
  const dispose = ctx.channel.register(createWebAdapter(ctx))
  ctx.effect(() => () => dispose())
}

export default { name, inject, apply }
