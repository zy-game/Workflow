/**
 * @qingmei/service-llm —— 模型服务的稳定门面。
 *
 * 契约真源是 @qingmei/core。本包把「模型」这一面再导出一次，让 provider 与消费方
 * 只依赖一个模块，不必同时认识 core 里的存储、渠道、网关契约。
 *
 * 本包不提供实现：名为 "llm" 的服务由具体 provider（如 @qingmei/provider-llm-echo）注册。
 */
import type { Context } from 'cordis'
import { LlmService, type ChatMessage, type ChatRequest, type ChatStreamChunk } from '@qingmei/core'

declare module 'cordis' {
  interface Context {
    /** 模型服务；由 provider 包注册，消费方用 inject 声明依赖 */
    llm: LlmService
  }
}

export { LlmService, type ChatMessage, type ChatRequest, type ChatStreamChunk }

export const name = 'service-llm'

/**
 * 门面包没有运行时行为：加载它不会注册任何服务。
 *
 * 需要可用的模型时，请加载一个 provider 包；本包只保证模型契约的导入路径稳定。
 */
export function apply(_ctx: Context): void {}

/** 兼容 `import serviceLlm from '@qingmei/service-llm'` 的组合根写法 */
export default { name, apply }
