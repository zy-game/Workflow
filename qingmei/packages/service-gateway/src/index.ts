/**
 * @qingmei/service-gateway —— HTTP 路由表与事件广播。
 *
 * 这里没有 socket、没有 node:http：宿主（host-gateway）负责监听，
 * 本服务只保存路由并提供 SSE 订阅点，让真正的传输层保持可替换。
 */
import type { Context } from 'cordis'
import {
  GatewayService,
  type GatewayEvent,
  type GatewayRequest,
  type GatewayResponse,
  type RouteDefinition,
} from '@qingmei/core'

export { GatewayService } from '@qingmei/core'
export type { GatewayEvent, GatewayRequest, GatewayResponse, RouteDefinition } from '@qingmei/core'

declare module 'cordis' {
  interface Context {
    gateway: GatewayService
  }
}

export type GatewayListener = (event: GatewayEvent) => void

/** 路由键：方法大写 + 规范化路径，避免 `/api/v1/x` 与 `api/v1/x` 被当成两条 */
export function routeKey(method: string, path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${method.toUpperCase()} ${normalized}`
}

export class GatewayHub extends GatewayService {
  private readonly routes = new Map<string, RouteDefinition>()
  private readonly listeners = new Set<GatewayListener>()

  constructor(ctx: Context) {
    super(ctx)
  }

  route(def: RouteDefinition): () => void {
    const key = routeKey(def.method, def.path)
    this.routes.set(key, def)
    let active = true
    return () => {
      if (!active) return
      active = false
      // 只在仍然是同一条定义时删除：旧 disposer 不能拆掉后来覆盖的路由。
      if (this.routes.get(key) === def) this.routes.delete(key)
    }
  }

  publish(event: GatewayEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.ctx.logger.warn('gateway 订阅者处理事件失败:', error)
      }
    }
  }

  subscribe(listener: GatewayListener): () => void {
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  match(method: string, path: string): RouteDefinition | undefined {
    return this.routes.get(routeKey(method, path))
  }

  async dispatch(request: GatewayRequest, response: GatewayResponse): Promise<boolean> {
    const def = this.match(request.method, request.path)
    if (!def) return false
    await def.handler(request, response)
    return true
  }

  get routeCount(): number {
    return this.routes.size
  }

  get subscriberCount(): number {
    return this.listeners.size
  }
}

export const name = 'service-gateway'

export const apply = (ctx: Context): void => {
  new GatewayHub(ctx)
}

export default { name, apply }
