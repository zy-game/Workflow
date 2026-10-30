export { MemoryService } from '@qingmei/core'
export type { MemoryRecord, RecalledFact, RecallQuery, RecallResult } from '@qingmei/core'

export const serviceVersion = 1
export const name = 'service-memory'

/** 门面包：只提供类型与抽象类，服务由 provider 注册。 */
export function apply(): void {
  // 无运行时行为
}

export default { name, apply }
