/**
 * @qingmei/service-channel —— 渠道注册表与出站路由。
 *
 * 服务只做三件事：收下适配器、按渠道转发信封、暴露在线状态。
 * 平台差异全部留在适配器里，这里不认识任何具体平台。
 */
import type { Context } from 'cordis'
import {
  ChannelService,
  type ChannelAdapter,
  type ChannelId,
  type OutboundEnvelope,
  type SendResult,
} from '@qingmei/core'

export { ChannelService } from '@qingmei/core'
export type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelId,
  OutboundEnvelope,
  SendResult,
} from '@qingmei/core'

declare module 'cordis' {
  interface Context {
    channel: ChannelService
  }
}

interface AdapterEntry {
  adapter: ChannelAdapter
  online: boolean
  released: boolean
  started: Promise<void>
}

export class ChannelHub extends ChannelService {
  private readonly adapters = new Map<ChannelId, AdapterEntry>()

  constructor(ctx: Context) {
    super(ctx)
  }

  register(adapter: ChannelAdapter): () => void {
    const previous = this.adapters.get(adapter.id)
    if (previous) void this.release(previous)

    const entry: AdapterEntry = {
      adapter,
      online: false,
      released: false,
      started: Promise.resolve(),
    }
    this.adapters.set(adapter.id, entry)

    entry.started = (async () => {
      try {
        await adapter.start()
        if (!entry.released && this.adapters.get(adapter.id) === entry) entry.online = true
      } catch (error) {
        this.report(`渠道 ${adapter.id} 启动失败`, error)
      }
    })()

    return () => this.release(entry)
  }

  async send(envelope: OutboundEnvelope): Promise<SendResult> {
    const entry = this.adapters.get(envelope.channel)
    if (!entry) return { ok: false, error: 'no adapter' }
    try {
      return await entry.adapter.send(envelope)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  status(): { id: ChannelId; online: boolean }[] {
    return [...this.adapters.values()].map((entry) => ({
      id: entry.adapter.id,
      online: entry.online,
    }))
  }

  private async release(entry: AdapterEntry): Promise<void> {
    if (entry.released) return
    entry.released = true
    entry.online = false
    if (this.adapters.get(entry.adapter.id) === entry) this.adapters.delete(entry.adapter.id)
    await entry.started
    try {
      await entry.adapter.stop()
    } catch (error) {
      this.report(`渠道 ${entry.adapter.id} 停止失败`, error)
    }
  }

  private report(message: string, error: unknown): void {
    this.ctx.logger.warn(message, error)
  }
}

export const name = 'service-channel'

export const apply = (ctx: Context): void => {
  new ChannelHub(ctx)
}

export default { name, apply }
