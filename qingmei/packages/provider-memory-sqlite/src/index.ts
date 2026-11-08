/**
 * @qingmei/provider-memory-sqlite —— 轻量事实记忆。
 *
 * 只做三件事：
 * - 显式写入事实（subject/predicate/object）；
 * - SQLite FTS5 关键词召回；
 * - owner/group 视口隔离。
 *
 * 不做：
 * - 每轮 LLM 抽取；
 * - synapse / working memory / 自动巩固；
 * - 自建向量与 embedding。
 *
 * 需要语义检索时再单独接入 Orama 或 sqlite-vec，不把这个 provider 继续做重。
 */
import { DatabaseSync } from 'node:sqlite'
import type { Context } from 'cordis'
import {
  MemoryService,
  uid,
  type MemoryRecord,
  type ProfileEntry,
  type RecallQuery,
  type RecallResult,
  type RecalledFact,
  type Row,
  type HistoryService,
} from '@qingmei/core'

export interface MemoryConfig {
  /** 召回条数上限 */
  limit?: number
  /** 低于该置信度不落库 */
  minConfidence?: number
}

export const name = 'provider-memory-sqlite'
export const inject = ['store']

const FACT_COLLECTION = 'qm_mem_fact'
const EPISODE_COLLECTION = 'qm_mem_episode'

interface FactRow extends Row {
  subject: string
  predicate: string
  object: string
  confidence: number
  salience?: number
  sensitivity: MemoryRecord['sensitivity']
  audience?: string
  device?: string
  origin_kind: string
  origin_id: string
  created_at: number
  valid_to: number | null
}

interface EpisodeRow extends Row {
  kind: string
  session_id: string
  summary: string
  subject: string
  predicate: string
  audience: string
  salience: number
  confidence: number
  origin_kind: string
  origin_id: string
  created_at: number
}

class FactFts {
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  private withDb<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.path)
    try {
      db.exec('PRAGMA busy_timeout = 3000')
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS qm_fact_fts USING fts5(id UNINDEXED, text, tokenize='unicode61')")
      return fn(db)
    } finally {
      db.close()
    }
  }

  private segment(value: string): string {
    return String(value)
      .replace(/[\u3400-\u9fff]/g, (char) => ` ${char} `)
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private write(db: DatabaseSync, id: string, text: string): void {
    db.prepare('DELETE FROM qm_fact_fts WHERE id = ?').run(id)
    db.prepare('INSERT INTO qm_fact_fts(id, text) VALUES (?, ?)').run(id, this.segment(text))
  }

  upsert(id: string, text: string): void {
    this.withDb((db) => this.write(db, id, text))
  }

  remove(id: string): void {
    this.withDb((db) => db.prepare('DELETE FROM qm_fact_fts WHERE id = ?').run(id))
  }

  sync(rows: FactRow[]): void {
    this.withDb((db) => {
      for (const row of rows) this.write(db, row.id, `${row.subject} ${row.predicate} ${row.object}`)
    })
  }

  search(text: string, limit: number): string[] {
    const tokens = this.segment(text).split(' ').filter(Boolean)
    if (tokens.length === 0) return []
    const match = tokens.map((token) => `"${token.replace(/"/g, '')}"`).join(' OR ')
    return this.withDb((db) => {
      const rows = db
        .prepare('SELECT id FROM qm_fact_fts WHERE qm_fact_fts MATCH ? LIMIT ?')
        .all(match, limit) as { id: string }[]
      return rows.map((row) => String(row.id))
    })
  }
}

export class SqliteMemory extends MemoryService {
  private readonly facts
  private readonly episodes
  private history: HistoryService | undefined
  private readonly limit: number
  private readonly minConfidence: number
  private readonly fts: FactFts | null

  constructor(ctx: Context, config: MemoryConfig = {}) {
    super(ctx)
    const store = ctx.store
    this.facts = store.collection<FactRow>(FACT_COLLECTION)
    this.episodes = store.collection<EpisodeRow>(EPISODE_COLLECTION)
    ctx.inject(['history'], (sub) => { this.history = sub.history })
    this.limit = config.limit ?? 8
    this.minConfidence = config.minConfidence ?? 0.6
    const path = store.filePath?.()
    this.fts = path && path !== ':memory:' ? new FactFts(path) : null
    if (this.fts) {
      void this.facts
        .find({})
        .then((rows) => this.fts?.sync(rows.filter((row) => !row.valid_to)))
        .catch(() => undefined)
    }
  }

  async ingest(records: MemoryRecord[]): Promise<{ created: string[]; merged: string[] }> {
    const created: string[] = []
    const merged: string[] = []
    for (const record of records) {
      const normalized = normalize(record)
      if (!normalized || normalized.confidence < this.minConfidence) continue

      if (normalized.kind !== 'fact') {
        const id = uid('ep')
        await this.episodes.insert({
          id,
          kind: normalized.kind,
          session_id: normalized.subject.startsWith('session:') ? normalized.subject.slice(8) : normalized.subject,
          summary: normalized.object,
          subject: normalized.subject,
          predicate: normalized.predicate,
          audience: normalized.audience ?? 'owner',
          salience: normalized.salience ?? 0.5,
          confidence: normalized.confidence,
          origin_kind: normalized.origin.kind,
          origin_id: normalized.origin.id,
          created_at: Date.now(),
        })
        created.push(id)
        continue
      }

      const live = await this.facts.find({
        where: { subject: normalized.subject, predicate: normalized.predicate, valid_to: null },
      })
      const same = live.find((row) => row.object === normalized.object)
      if (same) {
        await this.facts.update(same.id, {
          confidence: Math.max(same.confidence, normalized.confidence),
          salience: Math.max(same.salience ?? 0.5, normalized.salience ?? 0.5),
        })
        merged.push(same.id)
        continue
      }

      const now = Date.now()
      for (const row of live) {
        await this.facts.update(row.id, { valid_to: now })
        this.fts?.remove(row.id)
      }

      const row: Omit<FactRow, 'id'> = {
        subject: normalized.subject,
        predicate: normalized.predicate,
        object: normalized.object,
        confidence: normalized.confidence,
        salience: normalized.salience ?? 0.5,
        sensitivity: normalized.sensitivity,
        audience: normalized.audience ?? 'owner',
        ...(normalized.device ? { device: normalized.device } : {}),
        origin_kind: normalized.origin.kind,
        origin_id: normalized.origin.id,
        created_at: now,
        valid_to: null,
      }
      const inserted = await this.facts.insert(row)
      this.fts?.upsert(inserted.id, `${row.subject} ${row.predicate} ${row.object}`)
      created.push(inserted.id)
    }
    return { created, merged }
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    const audience = query.audience?.trim() || 'owner'
    const limit = clampLimit(query.limit ?? this.limit)
    const all = (await this.facts.find({})).filter((row) => visible(row, audience))
    if (all.length === 0) return { facts: [], text: '' }
    if (!query.text.trim()) {
      const facts = all
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit)
        .map(toFact)
      return { facts, text: facts.map((fact) => `- ${fact.subject} ${fact.predicate} ${fact.object}`).join('\n') }
    }

    const byId = new Map(all.map((row) => [row.id, row]))
    const hitIds = this.fts?.search(query.text, Math.max(20, limit * 4)) ?? []
    const tokens = tokenize(query.text)
    const scores = new Map<string, number>()
    for (const id of hitIds) if (byId.has(id)) scores.set(id, 1)
    for (const row of all) {
      const lexical = lexicalScore(row, tokens)
      if (lexical > 0) scores.set(row.id, Math.max(scores.get(row.id) ?? 0, lexical))
    }
    if (scores.size === 0) return { facts: [], text: '' }

    const facts = [...scores.entries()]
      .map(([id, score]) => {
        const row = byId.get(id)!
        const deviceBoost = query.device && row.device === query.device ? 0.1 : 0
        return { row, score: score + (row.salience ?? 0.5) * 0.35 + deviceBoost }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row }) => toFact(row))

    const text = facts
      .map((fact) => `- ${fact.subject} ${fact.predicate} ${fact.object}`)
      .join('\n')
    return { facts, text }
  }

  async forget(ids: string[]): Promise<number> {
    let count = 0
    for (const id of new Set(ids.map((item) => item.trim()).filter(Boolean))) {
      const row = await this.facts.get(id)
      if (!row || row.valid_to) continue
      await this.facts.update(id, { valid_to: Date.now() })
      this.fts?.remove(id)
      count += 1
    }
    return count
  }

  async listFacts(query: { limit?: number; audience?: string } = {}): Promise<RecalledFact[]> {
    const audience = query.audience ?? 'owner'
    return (await this.facts.find({}))
      .filter((row) => visible(row, audience))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, Math.min(200, Math.max(1, query.limit ?? 100)))
      .map(toFact)
  }

  async updateFact(
    id: string,
    patch: Partial<Pick<MemoryRecord, 'object' | 'confidence' | 'salience'>>,
  ): Promise<boolean> {
    const row = await this.facts.get(id)
    if (!row || row.valid_to) return false
    const next: Partial<FactRow> = {}
    if (typeof patch.object === 'string') {
      const object = patch.object.trim()
      if (!object || object.length > 200) return false
      next.object = object
    }
    if (patch.confidence !== undefined) {
      const confidence = Number(patch.confidence)
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return false
      next.confidence = confidence
    }
    if (patch.salience !== undefined) {
      const salience = Number(patch.salience)
      if (!Number.isFinite(salience) || salience < 0 || salience > 1) return false
      next.salience = salience
    }
    if (Object.keys(next).length === 0) return false
    await this.facts.update(id, next)
    const updated = await this.facts.get(id)
    if (updated) this.fts?.upsert(id, `${updated.subject} ${updated.predicate} ${updated.object}`)
    return true
  }

  async profile(query: { audience?: string; limit?: number } = {}): Promise<ProfileEntry[]> {
    const audience = query.audience ?? 'owner'
    if (audience !== 'owner') return []
    const rows = (await this.facts.find({}))
      .filter((row) => visible(row, 'owner'))
      .sort((a, b) => b.confidence - a.confidence)
    const grouped = new Map<string, ProfileEntry>()
    for (const row of rows) {
      const entry = grouped.get(row.subject) ?? { subject: row.subject, facts: [] }
      if (entry.facts.length < 8) {
        entry.facts.push({
          subject: row.subject,
          predicate: row.predicate,
          object: row.object,
          confidence: row.confidence,
        })
      }
      grouped.set(row.subject, entry)
    }
    return [...grouped.values()]
      .sort((a, b) => b.facts.length - a.facts.length)
      .slice(0, Math.min(20, Math.max(1, query.limit ?? 8)))
  }

  async summarize(sessionId: string): Promise<string> {
    const rows = (await this.history?.recent(sessionId, 20)) ?? []
    if (rows.length === 0) return ''
    const users = rows.filter((row) => row.role === 'user' && row.text.trim())
    const assistant = [...rows].reverse().find((row) => row.role === 'assistant' && row.text.trim())
    const topics = users
      .slice(-3)
      .map((row) => String(row.text).trim().replace(/\s+/g, ' ').slice(0, 60))
      .filter(Boolean)
    const parts = [`最近 ${users.length} 轮`]
    if (topics.length) parts.push(`用户提到：${topics.join('；')}`)
    if (assistant?.text) parts.push(`最近回复：${String(assistant.text).trim().replace(/\s+/g, ' ').slice(0, 80)}`)
    return parts.join('；').slice(0, 300)
  }
}

function normalize(record: MemoryRecord): MemoryRecord | null {
  if (!record || typeof record !== 'object') return null
  const subject = String(record.subject ?? '').trim().slice(0, 120)
  const predicate = String(record.predicate ?? '').trim().slice(0, 120)
  const object = String(record.object ?? '').trim().slice(0, 500)
  const confidence = Number(record.confidence)
  if (!subject || !predicate || !object) return null
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  const kind = ['fact', 'episode', 'decision', 'lesson'].includes(record.kind) ? record.kind : 'fact'
  const sensitivity = ['public', 'private', 'secret'].includes(record.sensitivity)
    ? record.sensitivity
    : 'private'
  return {
    ...record,
    kind,
    subject,
    predicate,
    object,
    confidence,
    sensitivity,
    salience: Math.min(1, Math.max(0, Number(record.salience ?? 0.5))),
    audience: String(record.audience ?? 'owner').trim() || 'owner',
    origin: record.origin ?? { kind: 'manual', id: 'unknown' },
  }
}

function visible(row: FactRow, audience: string): boolean {
  if (row.valid_to) return false
  if (row.sensitivity === 'secret') return false
  if (audience === 'owner') return (row.audience ?? 'owner') === 'owner'
  return row.sensitivity === 'public' && row.audience === audience
}

function toFact(row: FactRow): RecalledFact {
  return {
    id: row.id,
    kind: 'fact',
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    confidence: row.confidence,
    salience: row.salience,
    sensitivity: row.sensitivity,
    audience: row.audience ?? 'owner',
    ...(row.device ? { device: row.device } : {}),
    origin: {
      kind: row.origin_kind as MemoryRecord['origin']['kind'],
      id: row.origin_id,
    },
    createdAt: new Date(row.created_at),
    validTo: row.valid_to ? new Date(row.valid_to) : null,
  }
}

function tokenize(text: string): string[] {
  const raw = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const seen = new Set<string>()
  for (const word of raw) {
    if (word.length < 2) continue
    seen.add(word)
    for (const char of word) {
      if (/[\u3400-\u9fff]/.test(char)) seen.add(char)
    }
  }
  return [...seen]
}

function lexicalScore(row: FactRow, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const haystack = `${row.subject}${row.predicate}${row.object}`.toLowerCase()
  let hits = 0
  for (const token of tokens) if (haystack.includes(token)) hits += 1
  return hits / tokens.length
}

function clampLimit(value: number): number {
  return Math.min(50, Math.max(1, Math.round(Number(value) || 8)))
}

export function apply(ctx: Context, config: MemoryConfig = {}): void {
  void new SqliteMemory(ctx, config)
}

export const defaultExport = { name, inject, apply }
