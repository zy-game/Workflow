/**
 * @qingmei/provider-llm-openai —— OpenAI 兼容的模型提供方。
 *
 * 只要对方实现了 `POST /chat/completions`（含 SSE 流式），就能接：
 * DeepSeek 官方、sub2api 这类网关、vLLM、Ollama 的 /v1 端点等。
 */
import type { Context } from 'cordis'
import {
  LlmService,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamChunk,
} from '@qingmei/service-llm'

export interface OpenAiConfig {
  /** 例如 http://127.0.0.1:8081/v1（末尾斜杠会被规范化） */
  baseURL: string
  apiKey: string
  model: string
  maxTokens?: number
  temperature?: number
  /** 单次请求超时，默认 90s */
  timeoutMs?: number
}

export const name = 'provider-llm-openai'

export class OpenAiLlm extends LlmService {
  readonly baseURL: string
  readonly model: string
  private readonly apiKey: string
  private readonly maxTokens: number | undefined
  private readonly temperature: number | undefined
  private readonly timeoutMs: number

  constructor(ctx: Context, config: OpenAiConfig) {
    validateConfig(config)
    super(ctx)
    this.baseURL = config.baseURL.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.model = config.model
    this.maxTokens = config.maxTokens
    this.temperature = config.temperature
    this.timeoutMs = config.timeoutMs ?? 90_000
  }

  async complete(req: ChatRequest): Promise<{ text: string }> {
    const response = await this.post(req, false)
    const body = (await response.json()) as ChatCompletionResponse
    const text = body?.choices?.[0]?.message?.content
    if (typeof text !== 'string') {
      throw new Error(`[provider-llm-openai] 响应里没有 content：${truncate(JSON.stringify(body))}`)
    }
    return { text }
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const response = await this.post(req, true)
    if (!response.body) throw new Error('[provider-llm-openai] 流式响应没有 body')

    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body) {
      if (req.signal?.aborted) return
      buffer += decoder.decode(chunk, { stream: true })
      // SSE 事件以空行分隔；末尾可能是不完整事件，留在 buffer 里
      let index = buffer.indexOf('\n\n')
      while (index !== -1) {
        const rawEvent = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of rawEvent.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') {
            yield { type: 'done' }
            return
          }
          const parsed = safeJson<ChatCompletionChunk>(data)
          const delta = parsed?.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) yield { type: 'text', text: delta }
        }
        index = buffer.indexOf('\n\n')
      }
    }
    yield { type: 'done' }
  }

  private async post(req: ChatRequest, stream: boolean): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    req.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: req.messages.map(toWireMessage),
          stream,
          ...(this.maxTokens === undefined ? {} : { max_tokens: this.maxTokens }),
          ...(this.temperature === undefined ? {} : { temperature: this.temperature }),
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(
          `[provider-llm-openai] HTTP ${response.status} ${truncate(text)}`,
        )
      }
      return response
    } finally {
      clearTimeout(timer)
    }
  }
}

function toWireMessage(message: ChatMessage): { role: string; content: string } {
  return { role: message.role, content: message.content }
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[]
}

interface ChatCompletionChunk {
  choices?: { delta?: { content?: string } }[]
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function truncate(text: string, limit = 300): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

export function apply(ctx: Context, config: OpenAiConfig): void {
  ctx.plugin(OpenAiLlm, config)
}

/** 单独导出：组合根与测试可以在不构造 Service 的情况下先校验配置 */
export function validateConfig(config: OpenAiConfig): void {
  if (typeof config?.baseURL !== 'string' || config.baseURL.trim() === '') {
    throw new TypeError('[provider-llm-openai] config.baseURL 必须是非空字符串')
  }
  if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
    throw new TypeError('[provider-llm-openai] config.apiKey 必须是非空字符串')
  }
  if (typeof config.model !== 'string' || config.model.trim() === '') {
    throw new TypeError('[provider-llm-openai] config.model 必须是非空字符串')
  }
}

export const defaultExport = { name, apply }
