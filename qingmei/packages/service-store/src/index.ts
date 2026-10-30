/**
 * @qingmei/service-store —— store 服务契约的唯一公开入口。
 *
 * 契约本体在 @qingmei/core，本包只做重导出并声明 `ctx.store`，
 * 让消费方只依赖这一个包，而提供方可以整体替换。
 */
import { StoreService } from '@qingmei/core'
import type { Context } from 'cordis'

export { StoreService }
export type { Collection, Query, Row } from '@qingmei/core'

declare module 'cordis' {
  interface Context {
    store: StoreService
  }
}

export const name = 'service-store'

/** 门面包没有运行时行为：加载它不会注册任何服务。 */
export function apply(_ctx: Context): void {}

/** 服务契约版本；破坏性变更时递增。 */
export const serviceVersion = 1
