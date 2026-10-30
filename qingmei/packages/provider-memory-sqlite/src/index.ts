/**
 * @qingmei/provider-memory-sqlite —— 用 store 服务存事实记忆。
 *
 * M1 只做事实（subject/predicate/object）+ 关键词召回；
 * 向量、情节、巩固留给 neurons 阶段（docs/09）。
 */
import type { Context } from 'cordis'
import {
  MemoryService,
  uid,
  type MemoryRecord,
  type RecallQuery,
  type RecallResult,
  type RecalledFact,
  type Row,
  type StoreService,
} from '@qingmei/core'

export interface MemoryConfig {
  /** 召回条数上限 */
  limit?: number
  /** 低于该置信度不落库 */
  minConfidence?: number
}

export const name = 'provider-memory-sqlite'
export const inject = ['store']

const COLLECTION = 'qm_mem_fact'

interface FactRow extends Row {
  subject: string
  predicate: string
  object: string
  confidence: number
  sensitivity: string
  origin_kind: string
  origin_id: string
  created_at: number
  valid_to: number | null
}

export class SqliteMemory extends MemoryService {
  private readonly collection
  private readonly limit: number
  private readonly minConfidence: number

  constructor(ctx: Context, config: MemoryConfig = {}) {
    super(ctx)
    const store = ctx.reflect.get('store', false) as StoreService | undefined
    if (!store) throw new Error('[provider-memory-sqlite] 缺少 store 服务')
    this.collection = store.collection<FactRow>(COLLECTION)
    this.limit = config.limit ?? 8
    this.minConfidence = config.minConfidence ?? 0.6
  }

  async ingest(records: MemoryRecord[]): Promise<{ created: string[]; merged: string[] }> {
    const created: string[] = []
    const merged: string[] = []
    for (const record of records) {
      const normalized = normalize(record)
      if (!normalized || normalized.confidence < this.minConfidence) continue
      const existing = await this.collection.find({
        where: {
          subject: normalized.subject,
          predicate: normalized.predicate,
          object: normalized.object,
          valid_to: null,
        },
      })
      if (existing.length > 0) {
        const fact = existing[0]!
        // 同一事实再次被说出：提升置信度，不新增行
        await this.collection.update(fact.id, {
          confidence: Math.min(1, Math.max(fact.confidence, normalized.confidence) + 0.02),
        })
        merged.push(fact.id)
        continue
      }
      const row: Omit<FactRow, 'id'> = {
        subject: normalized.subject,
        predicate: normalized.predicate,
        object: normalized.object,
        confidence: normalized.confidence,
        sensitivity: normalized.sensitivity,
        origin_kind: normalized.origin.kind,
        origin_id: normalized.origin.id,
        created_at: Date.now(),
        valid_to: null,
      }
      const inserted = await this.collection.insert(row)
      created.push(inserted.id)
    }
    return { created, merged }
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    const rows = await this.collection.find({ where: { valid_to: null } })
    const tokens = tokenize(query.text)
    const scored = rows
      .filter((row) => row.sensitivity !== 'secret')
      .map((row) => ({ row, score: similarity(row, tokens) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.row.confidence - a.row.confidence || b.row.created_at - a.row.created_at)
      .slice(0, query.limit ?? this.limit)

    const facts: RecalledFact[] = scored.map(({ row }) => ({
      id: row.id,
      kind: 'fact',
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      confidence: row.confidence,
      sensitivity: row.sensitivity as MemoryRecord['sensitivity'],
      origin: { kind: row.origin_kind as MemoryRecord['origin']['kind'], id: row.origin_id },
      createdAt: new Date(row.created_at),
    }))
    const text = facts.map((fact) => `- ${fact.subject}${fact.predicate}${fact.object}`).join('\n')
    return { facts, text }
  }

  async forget(ids: string[]): Promise<number> {
    let count = 0
    for (const id of ids) {
      const row = await this.collection.get(id)
      if (!row || row.valid_to !== null) continue
      await this.collection.update(id, { valid_to: Date.now() })
      count += 1
    }
    return count
  }
}

/** 去掉空白与常见语气词，太小/太大的对象拒绝落库 */
function normalize(record: MemoryRecord): MemoryRecord | null {
  const subject = record.subject?.trim()
  const predicate = record.predicate?.trim()
  const object = record.object?.trim()
  if (!subject || !predicate || !object) return null
  if (object.length > 200 || subject.length > 60 || predicate.length > 40) return null
  return {
    kind: 'fact',
    subject,
    predicate,
    object,
    confidence: Math.min(1, Math.max(0, Number(record.confidence) || 0)),
    sensitivity: record.sensitivity ?? 'private',
    origin: record.origin ?? { kind: 'manual', id: 'unknown' },
  }
}

const STOPWORDS = new Set(['我', '你', '他', '她', '的', '了', '吗', '呢', '是', '在', '有', '和', '就', '都'])

/** 中文按二元词切，英文按空白切；去掉停用词 */
function tokenize(text: string): string[] {
  const lowered = text.toLowerCase()
  const words = lowered.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0)
  const tokens = new Set<string>()
  for (const word of words) {
    if (!STOPWORDS.has(word)) tokens.add(word)
    if (/[\u4e00-\u9fff]/.test(word)) {
      for (let i = 0; i + 1 < word.length; i++) {
        const bigram = word.slice(i, i + 2)
        if (!STOPWORDS.has(bigram)) tokens.add(bigram)
      }
    }
  }
  return [...tokens]
}

function similarity(row: FactRow, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const haystack = `${row.subject}${row.predicate}${row.object}`.toLowerCase()
  let hits = 0
  for (const token of tokens) if (haystack.includes(token)) hits += 1
  return hits / tokens.length
}

export function apply(ctx: Context, config: MemoryConfig = {}): void {
  ctx.plugin(SqliteMemory, config)
}

export const defaultExport = { name, inject, apply }
