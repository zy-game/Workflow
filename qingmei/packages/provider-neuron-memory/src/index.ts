/**
 * @qingmei/provider-neuron-memory —— 纯神经元记忆。
 *
 * 不使用 FTS、不使用向量库、不调用 LLM。
 *
 * 模型：
 *   Neuron   神经单元（token / episode / concept）
 *   Synapse  点触（有向、带权重、可衰减）
 *   Episode  事件（一次经历）
 *
 * 召回不是 cosine，而是：
 *   种子神经元 → 阈值发放 → 沿点触扩散 → 事件绑定打分
 *
 * 学习是 Hebbian：
 *   共同发放 → 点触增强；长期不用 → 衰减/剪枝
 */
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

export interface NeuronMemoryConfig {
  /** 单次召回最多返回 */
  limit?: number
  /** 低于该置信度的事实不落库 */
  minConfidence?: number
  /** 激活扩散 tick 数 */
  ticks?: number
  /** 每 tick 最多发放多少神经元 */
  maxFiring?: number
  /** 激活衰减 */
  decay?: number
  /** Hebbian 学习率 */
  learnRate?: number
  /** 每次学习时点触全局衰减 */
  synapseDecay?: number
  /** 低于该权重的点触剪枝 */
  pruneBelow?: number
  /** 夜间沉淀间隔；0 关闭 */
  consolidateEveryMs?: number
}

export const name = 'provider-neuron-memory'
export const inject = ['store']

const NEURON = 'qm_neuron'
const SYNAPSE = 'qm_synapse'
const EPISODE = 'qm_episode'
const BINDING = 'qm_neuron_binding'
const FACT = 'qm_mem_fact'
const DEFAULT_CONSOLIDATE_MS = 6 * 60 * 60_000

interface NeuronRow extends Row {
  kind: 'token' | 'concept' | 'episode'
  label: string
  threshold: number
  salience: number
  last_fired: number
  created_at: number
  valid_to: number | null
}

interface SynapseRow extends Row {
  from_id: string
  to_id: string
  weight: number
  kind: 'association' | 'temporal'
  last_fired: number
  created_at: number
  valid_to: number | null
}

interface EpisodeRow extends Row {
  text: string
  session_id: string
  audience: string
  sensitivity: MemoryRecord['sensitivity']
  salience: number
  confidence: number
  origin_kind: string
  origin_id: string
  created_at: number
  valid_to: number | null
}

interface BindingRow extends Row {
  owner_id: string
  owner_kind: 'fact' | 'episode'
  neuron_id: string
  weight: number
  position: number
}

interface FactRow extends Row {
  subject: string
  predicate: string
  object: string
  confidence: number
  salience: number
  sensitivity: MemoryRecord['sensitivity']
  audience: string
  device?: string
  origin_kind: string
  origin_id: string
  created_at: number
  valid_to: number | null
}

interface RuntimeNeuron {
  row: NeuronRow
  activation: number
  fired: number
}

const STOPWORDS = new Set([
  '的','了','和','是','在','我','你','他','她','它','们','这','那','有','就','不','也','都','而','与','及','或','一个','什么','怎么','可以','需要','进行','以及','这个','那个',
])

/**
 * 纯确定性分词：中文单字 + 双字，英文/数字词。
 * 这不是语义模型，是“感知编码”；语义来自后续点触学习。
 */
export function tokenize(text: string): string[] {
  const normalized = String(text ?? '').toLowerCase().normalize('NFKC')
  const parts = normalized.match(/[\p{Script=Han}]+|[a-z0-9_]+/gu) ?? []
  const out = new Set<string>()
  for (const part of parts) {
    if (/[\p{Script=Han}]/u.test(part)) {
      const chars = [...part]
      for (const char of chars) if (!STOPWORDS.has(char)) out.add(char)
      for (let i = 0; i < chars.length - 1; i += 1) out.add(`${chars[i]}${chars[i + 1]}`)
      if (chars.length <= 8 && !STOPWORDS.has(part)) out.add(part)
    } else if (part.length >= 2 && !STOPWORDS.has(part)) {
      out.add(part)
    }
  }
  return [...out]
}

export class NeuronMemory extends MemoryService {
  private readonly neurons
  private readonly synapses
  private readonly episodes
  private readonly bindings
  private readonly facts
  private history: HistoryService | undefined
  private readonly limit: number
  private readonly minConfidence: number
  private readonly ticks: number
  private readonly maxFiring: number
  private readonly decay: number
  private readonly learnRate: number
  private readonly synapseDecay: number
  private readonly pruneBelow: number
  private readonly byLabel = new Map<string, string>()
  private readonly byId = new Map<string, RuntimeNeuron>()
  private readonly outgoing = new Map<string, SynapseRow[]>()
  private readonly byOwner = new Map<string, BindingRow[]>()
  private ready: Promise<void>
  private stopped = false

  constructor(ctx: Context, config: NeuronMemoryConfig = {}) {
    super(ctx)
    const store = ctx.store
    this.neurons = store.collection<NeuronRow>(NEURON)
    this.synapses = store.collection<SynapseRow>(SYNAPSE)
    this.episodes = store.collection<EpisodeRow>(EPISODE)
    this.bindings = store.collection<BindingRow>(BINDING)
    this.facts = store.collection<FactRow>(FACT)
    ctx.inject(['history'], (sub) => { this.history = sub.history })
    this.limit = config.limit ?? 8
    this.minConfidence = config.minConfidence ?? 0.6
    this.ticks = Math.max(1, config.ticks ?? 4)
    this.maxFiring = Math.max(8, config.maxFiring ?? 64)
    this.decay = clamp(config.decay ?? 0.72, 0.1, 0.99)
    this.learnRate = clamp(config.learnRate ?? 0.08, 0.001, 1)
    this.synapseDecay = clamp(config.synapseDecay ?? 0.002, 0, 0.2)
    this.pruneBelow = clamp(config.pruneBelow ?? 0.015, 0.001, 0.5)
    this.ready = this.load()
    void this.ready.then(() => this.backfill()).catch(() => undefined)
    if ((config.consolidateEveryMs ?? DEFAULT_CONSOLIDATE_MS) > 0) {
      const timer = setInterval(
        () => void this.consolidate().catch(() => undefined),
        config.consolidateEveryMs ?? DEFAULT_CONSOLIDATE_MS,
      )
      timer.unref?.()
      ctx.effect(() => () => {
        this.stopped = true
        clearInterval(timer)
      })
    }
  }

  private async load(): Promise<void> {
    for (const row of await this.neurons.find({})) {
      if (row.valid_to) continue
      const runtime: RuntimeNeuron = { row, activation: 0, fired: 0 }
      this.byId.set(row.id, runtime)
      this.byLabel.set(row.label, row.id)
    }
    for (const row of await this.synapses.find({})) {
      if (row.valid_to) continue
      const list = this.outgoing.get(row.from_id) ?? []
      list.push(row)
      this.outgoing.set(row.from_id, list)
    }
    for (const row of await this.bindings.find({})) {
      const list = this.byOwner.get(row.owner_id) ?? []
      list.push(row)
      this.byOwner.set(row.owner_id, list)
    }
  }

  private async backfill(): Promise<void> {
    for (const row of await this.facts.find({})) {
      if (this.stopped) return
      if (!row.valid_to && !this.byOwner.has(row.id)) {
        await this.bind(row.id, 'fact', `${row.subject} ${row.predicate} ${row.object}`)
      }
    }
    for (const row of await this.episodes.find({})) {
      if (this.stopped) return
      if (!row.valid_to && !this.byOwner.has(row.id)) {
        await this.bind(row.id, 'episode', row.text)
      }
    }
  }

  private async neuron(label: string, kind: NeuronRow['kind']): Promise<NeuronRow> {
    await this.ready
    let id = this.byLabel.get(label)
    if (id) {
      const existing = this.byId.get(id)
      if (existing && !existing.row.valid_to) return existing.row
    }
    const row = await this.neurons.insert({
      kind,
      label,
      threshold: kind === 'episode' ? 0.45 : 0.3,
      salience: kind === 'episode' ? 0.7 : 0.5,
      last_fired: 0,
      created_at: Date.now(),
      valid_to: null,
    })
    id = row.id
    this.byLabel.set(label, id)
    this.byId.set(id, { row, activation: 0, fired: 0 })
    return row
  }

  private async bind(ownerId: string, ownerKind: BindingRow['owner_kind'], text: string): Promise<void> {
    const tokens = tokenize(text)
    for (let i = 0; i < tokens.length; i += 1) {
      const neuron = await this.neuron(tokens[i]!, 'token')
      const existing = this.byOwner.get(ownerId)?.some((row) => row.neuron_id === neuron.id)
      if (existing) continue
      const binding = await this.bindings.insert({
        owner_id: ownerId,
        owner_kind: ownerKind,
        neuron_id: neuron.id,
        weight: 1,
        position: i,
      })
      const list = this.byOwner.get(ownerId) ?? []
      list.push(binding)
      this.byOwner.set(ownerId, list)
    }
  }

  private async learn(fired: string[]): Promise<void> {
    if (fired.length < 2) return
    const active = new Set(fired)
    for (const from of fired) {
      for (const to of fired) {
        if (from === to || !active.has(to)) continue
        const rows = this.outgoing.get(from) ?? []
        let row = rows.find((item) => item.to_id === to && !item.valid_to)
        if (!row) {
          row = await this.synapses.insert({
            from_id: from,
            to_id: to,
            weight: this.learnRate,
            kind: 'association',
            last_fired: Date.now(),
            created_at: Date.now(),
            valid_to: null,
          })
          rows.push(row)
          this.outgoing.set(from, rows)
        } else {
          const weight = Math.min(1, row.weight + this.learnRate * (1 - row.weight))
          await this.synapses.update(row.id, { weight, last_fired: Date.now() })
          row.weight = weight
          row.last_fired = Date.now()
        }
      }
    }
  }

  async ingest(records: MemoryRecord[]): Promise<{ created: string[]; merged: string[] }> {
    await this.ready
    const created: string[] = []
    const merged: string[] = []
    for (const record of records) {
      const normalized = normalize(record)
      if (!normalized || normalized.confidence < this.minConfidence) continue
      if (normalized.kind === 'fact') {
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
        for (const row of live) await this.facts.update(row.id, { valid_to: now })
        const row = await this.facts.insert({
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
        })
        await this.bind(row.id, 'fact', `${row.subject} ${row.predicate} ${row.object}`)
        created.push(row.id)
        continue
      }

      const row = await this.episodes.insert({
        text: normalized.object,
        session_id: normalized.subject.startsWith('session:') ? normalized.subject.slice(8) : normalized.subject,
        audience: normalized.audience ?? 'owner',
        sensitivity: normalized.sensitivity,
        salience: normalized.salience ?? 0.5,
        confidence: normalized.confidence,
        origin_kind: normalized.origin.kind,
        origin_id: normalized.origin.id,
        created_at: Date.now(),
        valid_to: null,
      })
      await this.bind(row.id, 'episode', row.text)
      created.push(row.id)
    }
    return { created, merged }
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    await this.ready
    const audience = query.audience?.trim() || 'owner'
    const limit = clampInt(query.limit ?? this.limit, 1, 50)
    const facts = (await this.facts.find({})).filter((row) => visible(row, audience))
    const episodes = (await this.episodes.find({})).filter((row) => visibleEpisode(row, audience))
    if (facts.length === 0 && episodes.length === 0) return { facts: [], text: '' }

    const seeds = tokenize(query.text)
      .map((token) => this.byLabel.get(token))
      .filter((id): id is string => Boolean(id))
    if (seeds.length === 0) {
      if (query.text.trim()) return this.lexicalFallback(facts, episodes, query.text, limit)
      return this.recent(facts, episodes, limit)
    }

    const scores = await this.spread(seeds)
    const factRows = new Map(facts.map((row) => [row.id, row]))
    const episodeRows = new Map(episodes.map((row) => [row.id, row]))
    const ranked: { score: number; id: string; kind: 'fact' | 'episode' }[] = []
    for (const [ownerId, bindings] of this.byOwner) {
      const row = factRows.get(ownerId) ?? episodeRows.get(ownerId)
      if (!row) continue
      let score = 0
      for (const binding of bindings) score += (scores.get(binding.neuron_id) ?? 0) * binding.weight
      if (score > 0) ranked.push({ score, id: ownerId, kind: factRows.has(ownerId) ? 'fact' : 'episode' })
    }
    if (ranked.length === 0) return this.lexicalFallback(facts, episodes, query.text, limit)

    ranked.sort((a, b) => b.score - a.score)
    const recalled: RecalledFact[] = []
    for (const hit of ranked.slice(0, limit)) {
      const row = hit.kind === 'fact' ? factRows.get(hit.id) : episodeRows.get(hit.id)
      if (!row) continue
      recalled.push(hit.kind === 'fact' ? toFact(row as FactRow) : toEpisode(row as EpisodeRow))
    }
    return { facts: recalled, text: recalled.map(formatFact).join('\n') }
  }

  private async spread(seeds: string[]): Promise<Map<string, number>> {
    const activation = new Map<string, number>()
    for (const id of seeds) activation.set(id, 1)
    const score = new Map<string, number>()
    for (let tick = 0; tick < this.ticks; tick += 1) {
      const firing = [...activation.entries()]
        .filter(([id, value]) => value >= (this.byId.get(id)?.row.threshold ?? 0.3))
        .sort((a, b) => b[1] - a[1])
        .slice(0, this.maxFiring)
      if (firing.length === 0) break
      for (const [id, value] of firing) {
        score.set(id, Math.max(score.get(id) ?? 0, value))
        const runtime = this.byId.get(id)
        if (runtime) {
          runtime.fired = Date.now()
          runtime.row.last_fired = runtime.fired
        }
      }
      const next = new Map<string, number>()
      for (const [id, value] of activation) next.set(id, value * this.decay)
      for (const [from, value] of firing) {
        for (const synapse of this.outgoing.get(from) ?? []) {
          if (synapse.valid_to) continue
          next.set(synapse.to_id, (next.get(synapse.to_id) ?? 0) + value * synapse.weight)
        }
      }
      for (const [id, value] of next) if (value > 0.01) activation.set(id, value)
      await this.learn(firing.map(([id]) => id))
    }
    return score
  }

  private recent(facts: FactRow[], episodes: EpisodeRow[], limit: number): RecallResult {
    const items = [
      ...facts.map((row) => ({ row, kind: 'fact' as const })),
      ...episodes.map((row) => ({ row, kind: 'episode' as const })),
    ].sort((a, b) => b.row.created_at - a.row.created_at)
    const recalled = items.slice(0, limit).map((item) =>
      item.kind === 'fact' ? toFact(item.row as FactRow) : toEpisode(item.row as EpisodeRow),
    )
    return { facts: recalled, text: recalled.map(formatFact).join('\n') }
  }

  private lexicalFallback(facts: FactRow[], episodes: EpisodeRow[], text: string, limit: number): RecallResult {
    const tokens = tokenize(text)
    if (tokens.length === 0) return this.recent(facts, episodes, limit)
    const score = (haystack: string): number => {
      const value = haystack.toLowerCase()
      return tokens.reduce((sum, token) => sum + (value.includes(token) ? 1 : 0), 0)
    }
    const ranked = [
      ...facts.map((row) => ({ score: score(`${row.subject}${row.predicate}${row.object}`), row, kind: 'fact' as const })),
      ...episodes.map((row) => ({ score: score(row.text), row, kind: 'episode' as const })),
    ].filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
    const recalled = ranked.map((item) =>
      item.kind === 'fact' ? toFact(item.row as FactRow) : toEpisode(item.row as EpisodeRow),
    )
    return { facts: recalled, text: recalled.map(formatFact).join('\n') }
  }

  async forget(ids: string[]): Promise<number> {
    await this.ready
    let count = 0
    for (const id of new Set(ids)) {
      const fact = await this.facts.get(id)
      if (fact && !fact.valid_to) {
        await this.facts.update(id, { valid_to: Date.now() })
        count += 1
        continue
      }
      const episode = await this.episodes.get(id)
      if (episode && !episode.valid_to) {
        await this.episodes.update(id, { valid_to: Date.now() })
        count += 1
      }
    }
    return count
  }

  async listFacts(query: { limit?: number; audience?: string } = {}): Promise<RecalledFact[]> {
    await this.ready
    const audience = query.audience ?? 'owner'
    return (await this.facts.find({}))
      .filter((row) => visible(row, audience))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, clampInt(query.limit ?? 100, 1, 200))
      .map(toFact)
  }

  async updateFact(
    id: string,
    patch: Partial<Pick<MemoryRecord, 'object' | 'confidence' | 'salience'>>,
  ): Promise<boolean> {
    await this.ready
    const row = await this.facts.get(id)
    if (!row || row.valid_to) return false
    const next: Partial<FactRow> = {}
    if (typeof patch.object === 'string') {
      const object = patch.object.trim()
      if (!object || object.length > 500) return false
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
    if (updated) {
      for (const binding of this.byOwner.get(id) ?? []) await this.bindings.delete(binding.id)
      this.byOwner.delete(id)
      await this.bind(id, 'fact', `${updated.subject} ${updated.predicate} ${updated.object}`)
    }
    return true
  }

  async profile(query: { audience?: string; limit?: number } = {}): Promise<ProfileEntry[]> {
    await this.ready
    if ((query.audience ?? 'owner') !== 'owner') return []
    const rows = (await this.facts.find({})).filter((row) => visible(row, 'owner'))
    const grouped = new Map<string, ProfileEntry>()
    for (const row of rows.sort((a, b) => b.confidence - a.confidence)) {
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
      .slice(0, clampInt(query.limit ?? 8, 1, 20))
  }

  async summarize(sessionId: string): Promise<string> {
    const rows = (await this.history?.recent(sessionId, 20)) ?? []
    if (rows.length === 0) return ''
    const users = rows.filter((row) => row.role === 'user' && row.text.trim())
    const assistant = [...rows].reverse().find((row) => row.role === 'assistant' && row.text.trim())
    const topics = users.slice(-3).map((row) => String(row.text).trim().replace(/\s+/g, ' ').slice(0, 60))
    const parts = [`最近 ${users.length} 轮`]
    if (topics.length) parts.push(`用户提到：${topics.join('；')}`)
    if (assistant?.text) parts.push(`最近回复：${String(assistant.text).trim().replace(/\s+/g, ' ').slice(0, 80)}`)
    return parts.join('；').slice(0, 300)
  }

  async consolidate() {
    await this.ready
    const episodes = (await this.episodes.find({}))
      .filter((row) => !row.valid_to)
      .sort((a, b) => (b.salience + b.created_at / 1e15) - (a.salience + a.created_at / 1e15))
      .slice(0, 20)
    let replayed = 0
    for (const episode of episodes) {
      const seeds = (this.byOwner.get(episode.id) ?? []).map((row) => row.neuron_id)
      if (seeds.length === 0) continue
      await this.spread(seeds)
      replayed += 1
    }
    let scanned = 0
    const now = Date.now()
    for (const list of this.outgoing.values()) {
      for (const synapse of list) {
        if (synapse.valid_to) continue
        scanned += 1
        const weight = synapse.weight * (1 - this.synapseDecay)
        if (weight < this.pruneBelow) {
          await this.synapses.update(synapse.id, { valid_to: now, weight })
          synapse.valid_to = now
        } else if (weight !== synapse.weight) {
          await this.synapses.update(synapse.id, { weight })
          synapse.weight = weight
        }
      }
    }
    return { at: new Date(), scanned: episodes.length, replayed, compressed: [] as string[] }
  }

  /** 当前图规模，供自治观察 */
  async stats(): Promise<{ neurons: number; synapses: number; episodes: number; facts: number }> {
    await this.ready
    return {
      neurons: this.byId.size,
      synapses: [...this.outgoing.values()].reduce((sum, list) => sum + list.filter((row) => !row.valid_to).length, 0),
      episodes: (await this.episodes.find({})).filter((row) => !row.valid_to).length,
      facts: (await this.facts.find({})).filter((row) => !row.valid_to).length,
    }
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
  const sensitivity = ['public', 'private', 'secret'].includes(record.sensitivity) ? record.sensitivity : 'private'
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

function visibleEpisode(row: EpisodeRow, audience: string): boolean {
  if (row.valid_to) return false
  if (row.sensitivity === 'secret') return false
  if (audience === 'owner') return row.audience === 'owner'
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
    audience: row.audience,
    ...(row.device ? { device: row.device } : {}),
    origin: { kind: row.origin_kind as MemoryRecord['origin']['kind'], id: row.origin_id },
    createdAt: new Date(row.created_at),
    validTo: row.valid_to ? new Date(row.valid_to) : null,
  }
}

function toEpisode(row: EpisodeRow): RecalledFact {
  return {
    id: row.id,
    kind: 'episode',
    subject: '事件',
    predicate: '摘要',
    object: row.text,
    confidence: row.confidence,
    salience: row.salience,
    sensitivity: row.sensitivity,
    audience: row.audience,
    origin: { kind: row.origin_kind as MemoryRecord['origin']['kind'], id: row.origin_id },
    createdAt: new Date(row.created_at),
    validTo: row.valid_to ? new Date(row.valid_to) : null,
  }
}

function formatFact(fact: RecalledFact): string {
  return `- ${fact.subject} ${fact.predicate} ${fact.object}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number(value) || min)))
}

export function apply(ctx: Context, config: NeuronMemoryConfig = {}): void {
  void new NeuronMemory(ctx, config)
}

export const defaultExport = { name, inject, apply }
