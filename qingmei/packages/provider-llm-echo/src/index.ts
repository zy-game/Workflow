/**
 * @qingmei/provider-llm-echo —— 回声模型。
 *
 * 不访问网络、不需要密钥，回答固定为「问候语 + 最后一条用户输入」，
 * 用来在没有真实模型的情况下把 P1 的对话闭环跑通。
 */
import type { Context } from 'cordis'
import {
  LlmService,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamChunk,
} from '@qingmei/service-llm'

export interface EchoConfig {
  /** 每轮回答的开头，例如「我是青梅，P1 版本先跑通闭环。」 */
  greeting: string
}

export const name = 'provider-llm-echo'

/** 相邻两片之间的停顿：让流式效果在宿主上可见 */
const CHUNK_DELAY_MS = 10

/** 单片长度上限（字）。下限 8 字由均分算法保证，见 sliceText。 */
const MAX_CHUNK = 20

export class EchoLlm extends LlmService {
  readonly greeting: string

  constructor(ctx: Context, config: EchoConfig) {
    const greeting = requireGreeting(config)
    super(ctx)
    this.greeting = greeting
  }

  async complete(req: ChatRequest): Promise<{ text: string }> {
    return { text: this.reply(req.messages) }
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const pieces = sliceText(this.reply(req.messages))
    for (let i = 0; i < pieces.length; i++) {
      if (req.signal?.aborted) return
      yield { type: 'text', text: pieces[i] }
      if (i < pieces.length - 1) await sleep(CHUNK_DELAY_MS, req.signal)
    }
    if (req.signal?.aborted) return
    yield { type: 'done' }
  }

  private reply(messages: ChatMessage[]): string {
    const last = lastUserContent(messages)
    if (last === undefined) {
      throw new Error('EchoLlm 需要至少一条 user 消息才能作答')
    }
    return `${this.greeting}\n你说：${last}`
  }
}

export function apply(ctx: Context, config: EchoConfig): void {
  ctx.plugin(EchoLlm, config)
}

function requireGreeting(config: EchoConfig): string {
  if (typeof config?.greeting !== 'string' || config.greeting.length === 0) {
    throw new TypeError('provider-llm-echo 需要 config.greeting：一个非空字符串')
  }
  return config.greeting
}

function lastUserContent(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return undefined
}

/**
 * 把整段回答切成 8~20 字的片。
 *
 * 先按上限算出最少片数，再把字数均分，余数从前往后各多给 1 字。
 * 因此只要文本不短于 8 字，每片都落在 [8, 20] 内；短于 8 字时只能整段一片。
 */
function sliceText(text: string): string[] {
  if (text.length === 0) return []
  const count = Math.max(1, Math.ceil(text.length / MAX_CHUNK))
  const base = Math.floor(text.length / count)
  const remainder = text.length % count
  const pieces: string[] = []
  let offset = 0
  for (let i = 0; i < count; i++) {
    const size = base + (i < remainder ? 1 : 0)
    pieces.push(text.slice(offset, offset + size))
    offset += size
  }
  return pieces
}

/** 等待 ms 毫秒；signal 中止时立即返回，让流式循环尽快退出 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
    // addEventListener 与上游 abort 之间可能已经错过事件，这里补一次检查
    if (signal?.aborted) finish()
  })
}

/** 兼容 `import echo from '@qingmei/provider-llm-echo'` 的组合根写法 */
export default { name, apply }
