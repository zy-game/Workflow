/**
 * @qingmei/provider-embedding-openai —— OpenAI 兼容 /embeddings 的可选实现。
 *
 * 不配置时记忆召回继续用本地哈希向量；配置后由 memory provider 自动优先使用。
 */
import type { Context } from 'cordis'
import { EmbeddingService } from '@qingmei/core'

export interface Config {
  /** 例如 https://api.openai.com/v1 */
  baseURL?: string
  apiKey?: string
  /** 例如 text-embedding-3-small */
  model?: string
  timeoutMs?: number
  /** 测试注入；默认全局 fetch */
  fetchImpl?: typeof fetch
}

export const name = 'provider-embedding-openai'
export const inject: string[] = []

export class OpenAiEmbedding extends EmbeddingService {
  private readonly baseURL: string
  private readonly apiKey: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.baseURL = String(config.baseURL ?? process.env.QM_EMBEDDING_BASE_URL ?? '').replace(/\/+$/, '')
    this.apiKey = String(config.apiKey ?? process.env.QM_EMBEDDING_KEY ?? '')
    this.model = String(config.model ?? process.env.QM_EMBEDDING_MODEL ?? 'text-embedding-3-small')
    this.timeoutMs = Math.max(500, Number(config.timeoutMs ?? 15_000))
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.baseURL) throw new Error('[embedding-openai] 缺少 baseURL')
    if (!this.apiKey) throw new Error('[embedding-openai] 缺少 apiKey')
    if (texts.length === 0) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`[embedding-openai] HTTP ${res.status}`)
      const body = (await res.json()) as {
        data?: { index?: number; embedding?: unknown }[]
      }
      const data = Array.isArray(body.data) ? [...body.data] : []
      if (data.length !== texts.length) throw new Error('[embedding-openai] 返回条数与输入不一致')
      data.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
      return data.map((item) => {
        if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
          throw new Error('[embedding-openai] 返回了空向量')
        }
        return item.embedding.map(Number)
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  new OpenAiEmbedding(ctx, config)
}

export default { name, inject, apply }
