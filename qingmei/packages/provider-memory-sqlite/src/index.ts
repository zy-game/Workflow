/**
 * @qingmei/provider-memory-sqlite —— 用 store 服务存事实记忆。
 *
 * M1 只做事实（subject/predicate/object）+ 关键词召回；向量、情节、巩固留给 neurons 阶段（docs/09）。
 *
 * 两条语义按 docs/02 / docs/05 M1：
 * - 同一 subject+predicate 出现新 object → 旧值 `valid_to = now`（软失效，不删除），召回只看未失效的；
 * - `audience` 决定可见范围：群聊视口只注入 public 且 audience 精确匹配的记忆（零泄露）。
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
  /** 老记录没有这一列，读取时按 owner 处理 */
  audience?: string
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

      // 同一 subject+predicate 的所有有效行：完全相同的三元组合并，不同 object 的让位
      const live = await this.collection.find({
        where: { subject: normalized.subject, predicate: normalized.predicate, valid_to: null },
      })
      const same = live.find((row) => row.object === normalized.object)
      if (same) {
        // 同一事实再次被说出：提升置信度，不新增行
        await this.collection.update(same.id, {
          confidence: Math.min(1, Math.max(same.confidence, normalized.confidence) + 0.02),
          audience: normalized.audience,
        })
        merged.push(same.id)
        continue
      }
      // 新值生效：旧值软失效（保留可追溯），docs/05 M1 验收要求「置位而非删除」
      const now = Date.now()
      for (const row of live) {
        await this.collection.update(row.id, { valid_to: now })
      }

      const row: Omit<FactRow, 'id'> = {
        subject: normalized.subject,
        predicate: normalized.predicate,
        object: normalized.object,
        confidence: normalized.confidence,
        sensitivity: normalized.sensitivity,
        audience: normalized.audience,
        origin_kind: normalized.origin.kind,
        origin_id: normalized.origin.id,
        created_at: now,
        valid_to: null,
      }
      const inserted = await this.collection.insert(row)
      created.push(inserted.id)
    }
    return { created, merged }
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    const audience = query.audience?.trim() || 'owner'
    const rows = await this.collection.find({ where: { valid_to: null } })
    const tokens = tokenize(query.text)
    const scored = rows
      .filter((row) => visibleTo(row, audience))
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
      audience: row.audience ?? 'owner',
      origin: { kind: row.origin_kind as MemoryRecord['origin']['kind'], id: row.origin_id },
      createdAt: new Date(row.created_at),
      validTo: null,
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
    audience: record.audience?.trim() || 'owner',
    origin: record.origin ?? { kind: 'manual', id: 'unknown' },
  }
}

/**
 * 视口可见性。
 *
 * - 主人视口：只给 audience=owner 的记忆；
 * - 群聊视口：只给 audience 精确等于该群的记忆，而且必须是 public——
 *   private/secret 一字都不注入（docs/05 M1 验收第 5 条）。
 */
function visibleTo(row: FactRow, audience: string): boolean {
  const owner = row.audience ?? 'owner'
  if (audience === 'owner') return owner === 'owner' && row.sensitivity !== 'secret'
  if (owner !== audience) return false
  return row.sensitivity === 'public'
}

const STOPWORDS = new Set(['我', '你', '他', '她', '的', '了', '吗', '呢', '是', '在', '有', '和', '就', '都'])

/**
 * 中文按「整词 + 二元词 + 单字」切，英文按空白切；去掉停用词。
 *
 * 单字是必要的：用户问「我养什么」时，事实是「主人 + 养 + 狗」，
 * 只切二元词得到「我养/养什/什么」，一个都命中不了「主人养狗」。
 */
function tokenize(text: string): string[] {
  const lowered = text.toLowerCase()
  const words = lowered.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0)
  const tokens = new Set<string>()
  for (const word of words) {
    if (!STOPWORDS.has(word)) tokens.add(word)
    if (/[\u4e00-\u9fff]/.test(word)) {
      for (let i = 0; i < word.length; i++) {
        const char = word[i]!
        if (!STOPWORDS.has(char)) tokens.add(char)
        const bigram = word.slice(i, i + 2)
        if (bigram.length === 2 && !STOPWORDS.has(bigram)) tokens.add(bigram)
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
