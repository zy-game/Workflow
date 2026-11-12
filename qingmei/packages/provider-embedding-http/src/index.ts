/**
 * @qingmei/provider-embedding-http —— 可选语义向量，走 OpenAI 兼容的 /embeddings。
 *
 * 默认不装。只有配置了 QM_EMBEDDING_URL（以及可选的 QM_EMBEDDING_KEY / QM_EMBEDDING_MODEL）才启用；
 * 没有它时记忆继续用词面匹配，不是降级故障。
 */
import type { Context } from 'cordis'
import { EmbeddingService } from '@qingmei/core'

export const name = 'provider-embedding-http'
export const inject = []

export interface EmbeddingConfig {
  url?: string
  apiKey?: string
  model?: string
  timeoutMs?: number
}

export class HttpEmbedding extends EmbeddingService {
  private readonly url: string
  private readonly apiKey: string
  private readonly model: string
  private readonly timeoutMs: number

  constructor(ctx: Context, config: EmbeddingConfig = {}) {
    super(ctx)
    this.url = String(config.url ?? '').trim()
    if (!this.url) throw new Error('provider-embedding-http 需要 url（QM_EMBEDDING_URL）')
    this.apiKey = String(config.apiKey ?? '')
    this.model = config.model ?? 'text-embedding-3-small'
    this.timeoutMs = Math.max(1000, config.timeoutMs ?? 10_000)
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`embedding HTTP ${response.status}`)
    const body = (await response.json()) as { data?: { embedding?: number[] }[] }
    const rows = Array.isArray(body.data) ? body.data : []
    if (rows.length !== texts.length) throw new Error('embedding 返回条数不匹配')
    return rows.map((row) => (Array.isArray(row.embedding) ? row.embedding : []))
  }
}

export function apply(ctx: Context, config: EmbeddingConfig = {}): void {
  const url = String(config.url ?? process.env.QM_EMBEDDING_URL ?? '').trim()
  if (!url) {
    // 没配端点就不注册服务：记忆继续词面匹配，不是故障
    return
  }
  void new HttpEmbedding(ctx, { ...config, url, apiKey: config.apiKey ?? process.env.QM_EMBEDDING_KEY })
}

export const defaultExport = { name, inject, apply }

