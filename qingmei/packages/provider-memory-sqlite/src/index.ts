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
  type ConsolidationReport,
  type MemoryRecord,
  type ProfileEntry,
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
const SYNAPSE_COLLECTION = 'qm_mem_synapse'
const PROVENANCE_COLLECTION = 'qm_mem_provenance'
const EVENT_COLLECTION = 'qm_memory_event'
const EPISODE_COLLECTION = 'qm_mem_episode'
const WORKING_COLLECTION = 'qm_mem_working'
const DAY_MS = 24 * 60 * 60 * 1000
const HALF_LIFE_MS = 30 * DAY_MS
const SPREAD = 0.6
const MAX_SPREAD_HOPS = 3
const MIN_SCORE = 0.005
const INITIAL_WEIGHT = 0.2
const WORKING_HALF_LIFE_MS = 2 * 60 * 60 * 1000
const WORKING_BOOST = 0.7
const WORKING_LIMIT = 8
const KEEP_PER_SUBJECT = 5
const COMPRESS_CONFIDENCE = 0.75
const COMPRESS_AGE_MS = 120 * DAY_MS
const PRUNE_WEIGHT = 0.05
const PRUNE_AGE_MS = 180 * DAY_MS

interface FactRow extends Row {
  subject: string
  predicate: string
  object: string
  confidence: number
  salience?: number
  activation?: number
  last_fired_at?: number | null
  /** 被召回的累计次数（热点打分用） */
  hits?: number
  sensitivity: string
  /** 老记录没有这一列，读取时按 owner 处理 */
  audience?: string
  origin_kind: string
  origin_id: string
  created_at: number
  valid_to: number | null
}

interface EventRow extends Row {
  source: string
  applied_at: number
  neuron_ids: string
}

interface ProvenanceRow extends Row {
  neuron_id: string
  origin_kind: string
  origin_id: string
  observed_at: number
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

interface WorkingRow extends Row {
  session_id: string
  ids_json: string
  at: number
}

interface MessageRow extends Row {
  role?: string
  text?: string
  session_id?: string
  sessionId?: string
  created_at?: number
}

interface SynapseRow extends Row {
  from_id: string
  to_id: string
  kind: string
  weight: number
  co_activated: number
  last_fired_at: number | null
}

export class SqliteMemory extends MemoryService {
  private readonly collection
  private readonly synapses
  private readonly provenance
  private readonly events
  private readonly episodes
  private readonly workingRows
  private readonly messages
  /** 会话 → 上一轮点亮的节点（工作记忆；进程内，重启清空） */
  private readonly working = new Map<string, { ids: string[]; at: number }>()
  private readonly limit: number
  private readonly minConfidence: number

  constructor(ctx: Context, config: MemoryConfig = {}) {
    super(ctx)
    const store = ctx.reflect.get('store', false) as StoreService | undefined
    if (!store) throw new Error('[provider-memory-sqlite] 缺少 store 服务')
    this.collection = store.collection<FactRow>(COLLECTION)
    this.synapses = store.collection<SynapseRow>(SYNAPSE_COLLECTION)
    this.provenance = store.collection<ProvenanceRow>(PROVENANCE_COLLECTION)
    this.events = store.collection<EventRow>(EVENT_COLLECTION)
    this.episodes = store.collection<EpisodeRow>(EPISODE_COLLECTION)
    this.workingRows = store.collection<WorkingRow>(WORKING_COLLECTION)
    this.messages = store.collection<MessageRow>('qm_message')
    this.limit = config.limit ?? 8
    this.minConfidence = config.minConfidence ?? 0.6
  }

  async summarize(sessionId: string): Promise<string> {
    const wanted = sessionId.startsWith('s_') ? sessionId : `s_${sessionId}`
    const rows = (await this.messages.find({}))
      .filter((row) => {
        const values = [row.session_id, row.sessionId]
        return values.some((value) => value === sessionId || value === wanted)
      })
      .sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0))
      .slice(-20)
    if (rows.length === 0) return ''
    const users = rows.filter((row) => row.role === 'user' && typeof row.text === 'string' && row.text.trim())
    const assistant = [...rows].reverse().find((row) => row.role === 'assistant' && typeof row.text === 'string')
    const topics = users
      .slice(-3)
      .map((row) => String(row.text).trim().replace(/\s+/g, ' ').slice(0, 60))
      .filter(Boolean)
    const parts = [`最近 ${users.length} 轮`]
    if (topics.length) parts.push(`用户提到：${topics.join('；')}`)
    if (assistant?.text) parts.push(`最近回复：${String(assistant.text).trim().replace(/\s+/g, ' ').slice(0, 80)}`)
    return parts.join('；').slice(0, 300)
  }
  async listFacts(query: { limit?: number; audience?: string } = {}): Promise<RecalledFact[]> {
    const audience = query.audience ?? 'owner'
    const rows = (await this.collection.find({}))
      .filter((row) => !row.valid_to && (row.audience ?? 'owner') === audience)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, Math.min(200, Math.max(1, query.limit ?? 100)))
    return rows.map((row) => ({
      id: row.id,
      kind: 'fact',
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      confidence: row.confidence,
      salience: row.salience,
      sensitivity: row.sensitivity as MemoryRecord['sensitivity'],
      audience: row.audience ?? 'owner',
      origin: { kind: row.origin_kind as MemoryRecord['origin']['kind'], id: row.origin_id },
      createdAt: new Date(row.created_at),
      validTo: null,
    }))
  }

  async updateFact(
    id: string,
    patch: Partial<Pick<MemoryRecord, 'object' | 'confidence' | 'salience'>>,
  ): Promise<boolean> {
    const row = await this.collection.get(id)
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
    await this.collection.update(id, next)
    return true
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

      // 幂等事件：同一上报只应用一次（docs/10 §4）
      const idempotencyKey = normalized.idempotencyKey?.trim()
      if (idempotencyKey && (await this.events.get(idempotencyKey))) continue

      // 同一 subject+predicate 的所有有效行：完全相同的三元组合并，不同 object 的让位
      const live = await this.collection.find({
        where: { subject: normalized.subject, predicate: normalized.predicate, valid_to: null },
      })
      const same = live.find((row) => row.object === normalized.object)
      if (same) {
        const now = Date.now()
        const provenanceId = provenanceKey(same.id, normalized.origin)
        // 同一来源重复上报：幂等，不再加权
        if (await this.provenance.get(provenanceId)) {
          merged.push(same.id)
          continue
        }
        // 多源印证：不同来源说出同一事实，置信度上升（docs/10 P5）
        await this.provenance.insert({
          id: provenanceId,
          neuron_id: same.id,
          origin_kind: normalized.origin.kind,
          origin_id: normalized.origin.id,
          observed_at: now,
        })
        await this.collection.update(same.id, {
          confidence: Math.min(1, Math.max(same.confidence, normalized.confidence) + 0.02),
          audience: normalized.audience,
        })
        await this.recordEvent(idempotencyKey, same.id, now, normalized.origin)
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
        salience: normalized.salience,
        sensitivity: normalized.sensitivity,
        audience: normalized.audience,
        origin_kind: normalized.origin.kind,
        origin_id: normalized.origin.id,
        created_at: now,
        hits: 0,
        valid_to: null,
      }
      const inserted = await this.collection.insert(row)
      await this.provenance.insert({
        id: provenanceKey(inserted.id, normalized.origin),
        neuron_id: inserted.id,
        origin_kind: normalized.origin.kind,
        origin_id: normalized.origin.id,
        observed_at: now,
      })
      await this.recordEvent(idempotencyKey, inserted.id, now, normalized.origin)
      created.push(inserted.id)
    }
    return { created, merged }
  }

  private async ensureWorking(sessionId: string): Promise<void> {
    if (this.working.has(sessionId)) return
    try {
      const row = await this.workingRows.get(sessionId)
      if (!row) return
      if (Date.now() - row.at > 2 * 60 * 60 * 1000) return
      this.working.set(sessionId, { ids: JSON.parse(row.ids_json) as string[], at: row.at })
    } catch {
      // 工作记忆只是加速，读失败就当没有
    }
  }

  private async saveWorking(sessionId: string, entry: { ids: string[]; at: number }): Promise<void> {
    const payload = { ids_json: JSON.stringify(entry.ids), at: entry.at }
    const existing = await this.workingRows.get(sessionId)
    if (existing) await this.workingRows.update(sessionId, payload)
    else await this.workingRows.insert({ id: sessionId, session_id: sessionId, ...payload })
  }
  private async recordEvent(
    key: string | undefined,
    neuronId: string,
    now: number,
    origin: MemoryRecord['origin'],
  ): Promise<void> {
    if (!key) return
    await this.events
      .insert({ id: key, source: origin.kind, applied_at: now, neuron_ids: JSON.stringify([neuronId]) })
      .catch(() => undefined)
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    if (query.sessionId) await this.ensureWorking(query.sessionId)
    const audience = query.audience?.trim() || 'owner'
    const visible = (await this.collection.find({ where: { valid_to: null } })).filter((row) =>
      visibleTo(row, audience),
    )
    const byId = new Map(visible.map((row) => [row.id, row]))
    const tokens = tokenize(query.text)
    const now = Date.now()

    // ① 种子：关键词命中；分数 = 相似度 + 激活 + 置信度 + 时效 + 显著度
    const candidates = new Map<string, number>()
    for (const row of visible) {
      const score = similarity(row, tokens)
      if (score <= 0) continue
      candidates.set(row.id, scoreOf(row, score, now))
    }

    // ①.5 工作记忆：同一会话上一轮点亮的节点按 2 小时半衰期继承，不依赖关键词
    const working = query.sessionId ? this.working.get(query.sessionId) : undefined
    if (working && working.ids.length > 0) {
      const decayed = Math.exp((-Math.LN2 * (now - working.at)) / WORKING_HALF_LIFE_MS)
      for (const id of working.ids) {
        const row = byId.get(id)
        if (!row) continue
        const boosted = WORKING_BOOST * decayed * scoreOf(row, 1, now)
        if (boosted > (candidates.get(id) ?? 0)) candidates.set(id, boosted)
      }
    }

    // ② 扩散：从种子沿突触走 ≤3 跳，每跳 γ 打折；只收可见节点
    const seedIds = [...candidates.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id]) => id)
    if (seedIds.length > 0) {
      const synapses = await this.synapses.find({})
      const adjacency = new Map<string, { to: string; weight: number }[]>()
      for (const edge of synapses) {
        if (edge.weight < PRUNE_WEIGHT) continue
        const forward = adjacency.get(edge.from_id) ?? []
        forward.push({ to: edge.to_id, weight: edge.weight })
        adjacency.set(edge.from_id, forward)
        const backward = adjacency.get(edge.to_id) ?? []
        backward.push({ to: edge.from_id, weight: edge.weight })
        adjacency.set(edge.to_id, backward)
      }

      const bestDepth = new Map<string, number>(seedIds.map((id) => [id, 0]))
      const queue = seedIds.map((id) => ({ id, activation: candidates.get(id) ?? 0, depth: 0 }))
      while (queue.length > 0) {
        const current = queue.shift()!
        if (current.depth >= MAX_SPREAD_HOPS) continue
        for (const edge of adjacency.get(current.id) ?? []) {
          if (!byId.has(edge.to)) continue
          const spread = SPREAD * current.activation * edge.weight
          if (spread <= (candidates.get(edge.to) ?? 0)) continue
          candidates.set(edge.to, spread)
          const depth = current.depth + 1
          if (depth < (bestDepth.get(edge.to) ?? Infinity)) {
            bestDepth.set(edge.to, depth)
            queue.push({ id: edge.to, activation: spread, depth })
          }
        }
      }
    }

    const scored = [...candidates.entries()]
      .filter(([, score]) => score > MIN_SCORE)
      .sort((a, b) => b[1] - a[1])
      .slice(0, query.limit ?? this.limit)
      .map(([id, score]) => ({ row: byId.get(id)!, score }))

    // ③ 更新工作记忆：本轮点亮的前 N 个节点留给下一轮
    if (query.sessionId && scored.length > 0) {
      const entry = { ids: scored.slice(0, WORKING_LIMIT).map((entry) => entry.row.id), at: now }
      this.working.set(query.sessionId, entry)
      void this.saveWorking(query.sessionId, entry).catch(() => undefined)
    }

    // ④ 召回无副作用：强化放到返回后异步做
    if (scored.length > 1) {
      void this.reinforce(scored.slice(0, 5).map((entry) => entry.row.id)).catch(() => undefined)
    }

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

  /** 赫布强化：一起被召回的事实连边、权重增长；同时重置激活时间 */
  private async reinforce(ids: string[]): Promise<void> {
    const now = Date.now()
    for (const id of ids) {
      const row = await this.collection.get(id)
      await this.collection.update(id, {
        activation: 1,
        last_fired_at: now,
        hits: (row?.hits ?? 0) + 1,
      })
    }
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const [from, to] = ids[i]! < ids[j]! ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!]
        const key = `${from}|${to}`
        const existing = await this.synapses.get(key)
        const weight = existing?.weight ?? INITIAL_WEIGHT
        const next = Math.min(1, Math.max(0, weight + 0.02 - 0.001 * weight))
        if (existing) {
          await this.synapses.update(key, {
            weight: next,
            co_activated: existing.co_activated + 1,
            last_fired_at: now,
          })
        } else {
          await this.synapses.insert({
            id: key,
            from_id: from,
            to_id: to,
            kind: 'associative',
            weight: next,
            co_activated: 1,
            last_fired_at: now,
          })
        }
      }
    }
  }

  /**
   * 夜间巩固：每个 subject 只保留价值最高的 5 条；
   * 其余里置信度低或过旧的事实软压缩（valid_to 置位，不删除），可追溯。
   */
  async consolidate(now = Date.now()): Promise<ConsolidationReport> {
    const rows = (await this.collection.find({ where: { valid_to: null } })).filter((row) =>
      visibleTo(row, 'owner'),
    )
    const bySubject = new Map<string, FactRow[]>()
    for (const row of rows) {
      const list = bySubject.get(row.subject) ?? []
      list.push(row)
      bySubject.set(row.subject, list)
    }

    const compressed: string[] = []
    for (const facts of bySubject.values()) {
      if (facts.length <= KEEP_PER_SUBJECT) continue
      const sorted = facts.slice().sort((a, b) => valueOf(b) - valueOf(a))
      for (const row of sorted.slice(KEEP_PER_SUBJECT)) {
        const age = now - row.created_at
        if (row.confidence >= COMPRESS_CONFIDENCE && age <= COMPRESS_AGE_MS) continue
        await this.collection.update(row.id, { valid_to: now })
        compressed.push(row.id)
      }
    }

    await this.prune(now)
    return { at: new Date(now), scanned: rows.length, compressed }
  }
  /** 剪枝：弱（w<0.05）且 180 天未共同激活的突触删除；返回删除条数 */
  async prune(now = Date.now()): Promise<number> {
    const synapses = await this.synapses.find({})
    let removed = 0
    for (const edge of synapses) {
      const stale = edge.last_fired_at === null || now - edge.last_fired_at > PRUNE_AGE_MS
      if (edge.weight < PRUNE_WEIGHT && stale) {
        if (await this.synapses.delete(edge.id)) removed += 1
      }
    }
    return removed
  }
  /**
   * 画像：只对 owner 视口开；按 subject 聚合，每个 subject 取置信度最高的几条。
   * 与 recall 的区别是「稳定」——不依赖当前这句话的关键词。
   */
  async profile(query: { audience?: string; limit?: number } = {}): Promise<ProfileEntry[]> {
    const audience = query.audience?.trim() || 'owner'
    if (audience !== 'owner') return []

    const rows = await this.collection.find({ where: { valid_to: null } })
    const sorted = rows
      .filter((row) => visibleTo(row, audience))
      .sort((a, b) => b.confidence - a.confidence || b.created_at - a.created_at)

    const bySubject = new Map<string, ProfileEntry['facts']>()
    for (const row of sorted) {
      const facts = bySubject.get(row.subject) ?? []
      if (facts.length >= 4) continue
      facts.push({ subject: row.subject, predicate: row.predicate, object: row.object, confidence: row.confidence })
      bySubject.set(row.subject, facts)
    }
    return [...bySubject.entries()]
      .slice(0, query.limit ?? 12)
      .map(([subject, facts]) => ({ subject, facts }))
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

function provenanceKey(neuronId: string, origin: MemoryRecord['origin']): string {
  return `${neuronId}|${origin.kind}|${origin.id}`
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}

/** 指数衰减：半衰期按显著度放大（重要的事忘得慢） */
function decay(at: number | null | undefined, halfLifeMs: number, now: number): number {
  if (!at) return 0
  const age = Math.max(0, now - at)
  return Math.exp((-Math.LN2 * age) / Math.max(1, halfLifeMs))
}

/** score = 0.35·相似 + 0.25·激活 + 0.20·置信 + 0.10·时效 + 0.10·显著度（docs/09 §4） */
function valueOf(row: FactRow): number {
  const salience = clamp01(row.salience ?? Math.min(1, row.confidence))
  return 0.6 * row.confidence + 0.4 * salience
}

function scoreOf(row: FactRow, similarity: number, now: number): number {
  const salience = clamp01(row.salience ?? Math.min(1, row.confidence))
  const activation = decay(row.last_fired_at ?? null, HALF_LIFE_MS * (1 + 2 * salience), now)
  const recency = decay(row.created_at, 90 * DAY_MS, now)
  return (
    0.35 * similarity +
    0.25 * activation +
    0.2 * row.confidence +
    0.1 * recency +
    0.1 * salience
  )
}

/** 去掉空白与常见语气词，太小/太大的对象拒绝落库 */
function normalize(record: MemoryRecord): MemoryRecord | null {
  const subject = record.subject?.trim()
  const predicate = record.predicate?.trim()
  const object = record.object?.trim()
  if (!subject || !predicate || !object) return null
  if (object.length > 200 || subject.length > 60 || predicate.length > 40) return null
  return {
    kind: record.kind ?? 'fact',
    subject,
    predicate,
    object,
    confidence: Math.min(1, Math.max(0, Number(record.confidence) || 0)),
    salience: clamp01(Number(record.salience ?? 0.5)),
    sensitivity: record.sensitivity ?? 'private',
    audience: record.audience?.trim() || 'owner',
    origin: record.origin ?? { kind: 'manual', id: 'unknown' },
    ...(record.idempotencyKey?.trim() ? { idempotencyKey: record.idempotencyKey.trim() } : {}),
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
  const memory = new SqliteMemory(ctx, config)
  // 启动时剪一次，之后每天一次（不阻塞启动）
  void memory.prune().catch(() => undefined)
  const timer = setInterval(() => void memory.prune().catch(() => undefined), 24 * 60 * 60 * 1000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))
}

export const defaultExport = { name, inject, apply }
