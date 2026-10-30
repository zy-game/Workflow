/**
 * @qingmei/qm-memory-extract —— 回合结束后异步抽取事实。
 *
 * 设计：不阻塞回复；抽取失败只记日志；抽取走 llm（便宜、结构化），
 * 与对话车道（DSH）解耦。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  type LlmService,
  type MemoryRecord,
  type MemoryService,
  type TurnEnd,
} from '@qingmei/core'

export interface ExtractConfig {
  /** 低于该置信度的事实丢弃 */
  minConfidence?: number
  /** 单回合最多抽多少条 */
  maxFacts?: number
  /** 太短的输入不抽（「好」「嗯」） */
  minInputChars?: number
}

export const name = 'qm-memory-extract'
export const inject = ['llm', 'memory']

const SYSTEM_PROMPT = [
  '你是一个记忆抽取器。',
  '从用户的话里抽取值得长期记住的事实，只输出 JSON 数组，不要解释、不要 Markdown。',
  '每个元素形如：{"subject":"主人","predicate":"下周三要去","object":"杭州","confidence":0.9}',
  '规则：',
  '1. subject 用稳定的主体名（主人 / 项目名 / 人名）。',
  '2. predicate 用简短动词短语；object 是被记住的内容。',
  '3. 只抽事实、偏好、计划、约定；不抽寒暄、情绪、临时语气。',
  '4. 没有可记的就输出 []。',
].join('\n')

export function apply(ctx: Context, config: ExtractConfig = {}): void {
  const llm = ctx.reflect.get('llm', false) as LlmService | undefined
  const memory = ctx.reflect.get('memory', false) as MemoryService | undefined
  if (!llm || !memory) return

  const minConfidence = config.minConfidence ?? 0.6
  const maxFacts = config.maxFacts ?? 5
  const minInputChars = config.minInputChars ?? 4

  ctx.events.on(EVENTS.turnEnd, (end: TurnEnd) => {
    void extract(end)
  })

  async function extract(end: TurnEnd): Promise<void> {
    const text = end.userText?.trim()
    if (!text || text.length < minInputChars) return
    if (text.length > 1000) return

    try {
      const { text: raw } = await llm.complete({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      })
      const records = parseFacts(raw, end.sessionId, minConfidence, maxFacts)
      if (records.length === 0) return
      const result = await memory.ingest(records)
      ctx.logger.info(
        `[qm-memory-extract] 新增 ${result.created.length} 条，合并 ${result.merged.length} 条`,
      )
    } catch (error) {
      ctx.logger.warn(`[qm-memory-extract] 抽取失败：${messageOf(error)}`)
    }
  }
}

export function parseFacts(
  raw: string,
  sessionId: string,
  minConfidence: number,
  maxFacts: number,
): MemoryRecord[] {
  const json = extractJsonArray(raw)
  if (!Array.isArray(json)) return []
  const records: MemoryRecord[] = []
  for (const item of json) {
    if (records.length >= maxFacts) break
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const subject = typeof record.subject === 'string' ? record.subject.trim() : ''
    const predicate = typeof record.predicate === 'string' ? record.predicate.trim() : ''
    const object = typeof record.object === 'string' ? record.object.trim() : ''
    if (!subject || !predicate || !object) continue
    const confidence = Math.min(1, Math.max(0, Number(record.confidence ?? 0.7)))
    if (confidence < minConfidence) continue
    records.push({
      kind: 'fact',
      subject,
      predicate,
      object,
      confidence,
      sensitivity: 'private',
      origin: { kind: 'channel', id: sessionId },
    })
  }
  return records
}

/** 容忍 ```json 围栏、前后废话，只取第一个合法数组 */
function extractJsonArray(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const defaultExport = { name, inject, apply }
