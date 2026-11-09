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
  type Collection,
  type ConceptProposal,
  type ConceptEvaluation,
  type ConceptChangeSummary,
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
  /** 一对 token 至少在多少个 episode 中共现才形成概念 */
  conceptMinSupport?: number
  /** 单次沉淀最多形成多少个概念 */
  maxConceptsPerRun?: number
  /** 自动应用低风险概念变更（每次沉淀最多一条） */
  autoApplyConcepts?: boolean
}

export const name = 'provider-neuron-memory'
export const inject = ['store']

const NEURON = 'qm_neuron'
const SYNAPSE = 'qm_synapse'
const EPISODE = 'qm_episode'
const BINDING = 'qm_neuron_binding'
const FACT = 'qm_mem_fact'
const CHANGE = 'qm_neuron_change'
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

interface ChangeRow extends Row {
  kind: 'merge' | 'split'
  proposal_json: string
  before_json: string
  after_json: string
  status: 'applied' | 'rolled_back'
  created_at: number
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
  private readonly changes
  private history: HistoryService | undefined
  private readonly limit: number
  private readonly minConfidence: number
  private readonly ticks: number
  private readonly maxFiring: number
  private readonly decay: number
  private readonly learnRate: number
  private readonly synapseDecay: number
  private readonly pruneBelow: number
  private readonly conceptMinSupport: number
  private readonly maxConceptsPerRun: number
  private readonly autoApplyConcepts: boolean
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
    this.changes = store.collection<ChangeRow>(CHANGE)
    ctx.inject(['history'], (sub) => { this.history = sub.history })
    this.limit = config.limit ?? 8
    this.minConfidence = config.minConfidence ?? 0.6
    this.ticks = Math.max(1, config.ticks ?? 4)
    this.maxFiring = Math.max(8, config.maxFiring ?? 64)
    this.decay = clamp(config.decay ?? 0.72, 0.1, 0.99)
    this.learnRate = clamp(config.learnRate ?? 0.08, 0.001, 1)
    this.synapseDecay = clamp(config.synapseDecay ?? 0.002, 0, 0.2)
    this.pruneBelow = clamp(config.pruneBelow ?? 0.015, 0.001, 0.5)
    this.conceptMinSupport = Math.max(2, Math.round(config.conceptMinSupport ?? 2))
    this.maxConceptsPerRun = Math.max(1, Math.min(100, Math.round(config.maxConceptsPerRun ?? 20)))
    this.autoApplyConcepts = config.autoApplyConcepts === true
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

    const rawTokens = tokenize(query.text)
    const semanticTokens = rawTokens.filter((token) => token.length >= 2)
    const hasSemanticNeuron = semanticTokens.some((token) => this.byLabel.has(token))
    const queryTokens = hasSemanticNeuron ? semanticTokens : rawTokens
    const seeds = queryTokens
      .map((token) => this.byLabel.get(token))
      .filter((id): id is string => Boolean(id))
    if (seeds.length === 0) {
      if (query.text.trim()) return this.lexicalFallback(facts, episodes, query.text, limit, queryTokens)
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
    if (ranked.length === 0) return this.lexicalFallback(facts, episodes, query.text, limit, queryTokens)

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

  private lexicalFallback(facts: FactRow[], episodes: EpisodeRow[], text: string, limit: number, preferred?: string[]): RecallResult {
    const tokens = preferred && preferred.length > 0 ? preferred : tokenize(text)
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
    const beforeConsolidate = await this.snapshotGraph()
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
    const concepts = await this.formConcepts(episodes)
    const autoApplied = this.autoApplyConcepts ? await this.applySafeConceptChange(beforeConsolidate) : null
    return { at: new Date(), scanned: episodes.length, replayed, concepts, autoApplied, compressed: [] as string[] }
  }

  /** 从重复共现的 token 对形成概念神经元，并绑定到 episode。 */
  /** 只应用低风险变更：100% 回放的 merge，或分组明确的 split。 */
  private async applySafeConceptChange(beforeSnapshot?: GraphSnapshot): Promise<string | null> {
    const proposals = await this.conceptProposals()
    for (const proposal of proposals) {
      const evaluation = await this.evaluateConceptChange(proposal)
      if (!evaluation?.canApply) continue
      if (proposal.kind === 'merge') {
        if (evaluation.overlap < 0.99 || evaluation.affectedEpisodes > 20) continue
      } else if (proposal.kind === 'split') {
        const groups = proposal.payload?.groups ?? []
        if (groups.length < 2 || evaluation.affectedEpisodes > 30) continue
      } else {
        continue
      }
      const applied = await this.applyConceptChange(proposal, beforeSnapshot)
      if (applied) return applied.changeId
    }
    return null
  }

  private async formConcepts(episodes: EpisodeRow[]): Promise<number> {
    const support = new Map<string, { a: string; b: string; episodes: Set<string> }>()
    for (const episode of episodes) {
      const ids = [...new Set((this.byOwner.get(episode.id) ?? [])
        .map((row) => row.neuron_id)
        .filter((id) => this.byId.get(id)?.row.kind === 'token'))].slice(0, 24)
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const a = ids[i]!
          const b = ids[j]!
          const key = a < b ? `${a}|${b}` : `${b}|${a}`
          const entry = support.get(key) ?? { a, b, episodes: new Set<string>() }
          entry.episodes.add(episode.id)
          support.set(key, entry)
        }
      }
    }
    const candidates = [...support.values()]
      .filter((entry) => entry.episodes.size >= this.conceptMinSupport)
      .sort((a, b) => b.episodes.size - a.episodes.size)
      .slice(0, this.maxConceptsPerRun)
    let created = 0
    for (const candidate of candidates) {
      const left = this.byId.get(candidate.a)
      const right = this.byId.get(candidate.b)
      if (!left || !right) continue
      const label = `concept:${left.row.label}+${right.row.label}`
      const concept = await this.neuron(label, 'concept')
      let fresh = false
      if (!this.byId.get(concept.id) || this.byId.get(concept.id)!.row.created_at === concept.created_at) fresh = true
      await this.link(candidate.a, concept.id, 0.45)
      await this.link(candidate.b, concept.id, 0.45)
      await this.link(concept.id, candidate.a, 0.25)
      await this.link(concept.id, candidate.b, 0.25)
      for (const episodeId of candidate.episodes) {
        const existing = this.byOwner.get(episodeId)?.some((row) => row.neuron_id === concept.id)
        if (existing) continue
        const binding = await this.bindings.insert({
          owner_id: episodeId,
          owner_kind: 'episode',
          neuron_id: concept.id,
          weight: 0.7,
          position: 999,
        })
        const list = this.byOwner.get(episodeId) ?? []
        list.push(binding)
        this.byOwner.set(episodeId, list)
      }
      if (fresh) created += 1
    }
    return created
  }

  private async link(fromId: string, toId: string, weight: number): Promise<void> {
    const rows = this.outgoing.get(fromId) ?? []
    const existing = rows.find((row) => row.to_id === toId && !row.valid_to)
    if (existing) {
      if (existing.weight < weight) {
        await this.synapses.update(existing.id, { weight })
        existing.weight = weight
      }
      return
    }
    const row = await this.synapses.insert({
      from_id: fromId,
      to_id: toId,
      weight,
      kind: 'association',
      last_fired: Date.now(),
      created_at: Date.now(),
      valid_to: null,
    })
    rows.push(row)
    this.outgoing.set(fromId, rows)
  }

  /** 当前图规模，供自治观察 */
  async conceptProposals(): Promise<ConceptProposal[]> {
    await this.ready
    const sets = await this.conceptEpisodeSets()
    const concepts = [...this.byId.values()].filter((item) => item.row.kind === 'concept' && !item.row.valid_to)
    const proposals: ConceptProposal[] = []
    const merges: ConceptProposal[] = []
    for (let i = 0; i < concepts.length; i += 1) {
      for (let j = i + 1; j < concepts.length; j += 1) {
        const a = sets.get(concepts[i]!.row.id)
        const b = sets.get(concepts[j]!.row.id)
        if (!a || !b || a.size < 2 || b.size < 2) continue
        const overlap = [...a].filter((id) => b.has(id)).length / new Set([...a, ...b]).size
        if (overlap < 0.8) continue
        const source = a.size <= b.size ? concepts[i]!.row.id : concepts[j]!.row.id
        const target = source === concepts[i]!.row.id ? concepts[j]!.row.id : concepts[i]!.row.id
        merges.push({ id: `merge:${source}:${target}`, kind: 'merge', sourceId: source, targetId: target, reason: `episode 重叠 ${(overlap * 100).toFixed(0)}%`, risk: 'medium' })
      }
    }
    for (const concept of concepts) {
      const set = sets.get(concept.row.id)
      if (!set || set.size < 8) continue
      const sessions = new Map<string, string[]>()
      for (const episodeId of set) {
        const episode = await this.episodes.get(episodeId)
        if (!episode || episode.valid_to) continue
        const list = sessions.get(episode.session_id) ?? []
        list.push(episodeId)
        sessions.set(episode.session_id, list)
      }
      const groups = [...sessions.values()].filter((group) => group.length > 0)
      if (groups.length >= 2) {
        proposals.push({ id: `split:${concept.row.id}`, kind: 'split', conceptId: concept.row.id, reason: `绑定了 ${set.size} 个 episode、${groups.length} 个 session，建议拆成独立概念`, risk: 'medium', payload: { groups } })
      }
    }
    return [...proposals, ...merges].slice(0, 20)
  }

  async evaluateConceptChange(proposal: ConceptProposal): Promise<ConceptEvaluation | null> {
    await this.ready
    const sets = await this.conceptEpisodeSets()
    if (proposal.kind === 'merge') {
      const a = sets.get(proposal.sourceId ?? '') ?? new Set<string>()
      const b = sets.get(proposal.targetId ?? '') ?? new Set<string>()
      if (a.size === 0 || b.size === 0) return null
      return {
        kind: 'merge',
        affectedConcepts: 2,
        affectedEpisodes: new Set([...a, ...b]).size,
        overlap: [...a].filter((id) => b.has(id)).length / new Set([...a, ...b]).size,
        canApply: true,
        risk: 'medium',
      }
    }
    if (proposal.kind === 'split') {
      const set = sets.get(proposal.conceptId ?? '') ?? new Set<string>()
      if (set.size === 0) return null
      const groups = proposal.payload?.groups?.filter((group) => Array.isArray(group) && group.length > 0) ?? []
      return { kind: 'split', affectedConcepts: 1, affectedEpisodes: set.size, overlap: 0, canApply: groups.length >= 2, risk: 'medium' }
    }
    return null
  }

  async applyConceptChange(proposal: ConceptProposal, beforeSnapshot?: GraphSnapshot): Promise<{ changeId: string } | null> {
    await this.ready
    if (proposal.kind === 'split') return this.applySplit(proposal, beforeSnapshot)
    if (proposal.kind !== 'merge' || !proposal.sourceId || !proposal.targetId) return null
    const source = this.byId.get(proposal.sourceId)
    const target = this.byId.get(proposal.targetId)
    if (!source || !target || source.row.kind !== 'concept' || target.row.kind !== 'concept') return null
    if (source.row.valid_to || target.row.valid_to) return null
    const before = JSON.stringify(beforeSnapshot ?? await this.snapshotGraph())
    for (const [ownerId, bindings] of [...this.byOwner.entries()]) {
      const sourceBindings = bindings.filter((row) => row.neuron_id === proposal.sourceId)
      if (sourceBindings.length === 0) continue
      const hasTarget = bindings.some((row) => row.neuron_id === proposal.targetId)
      for (const binding of sourceBindings) {
        if (hasTarget) await this.bindings.delete(binding.id)
        else await this.bindings.update(binding.id, { neuron_id: proposal.targetId })
        void ownerId
      }
    }
    await this.neurons.update(proposal.sourceId, { valid_to: Date.now() })
    const after = JSON.stringify(await this.snapshotGraph())
    const change = await this.changes.insert({
      kind: 'merge',
      proposal_json: JSON.stringify(proposal),
      before_json: before,
      after_json: after,
      status: 'applied',
      created_at: Date.now(),
    })
    this.byId.clear()
    this.byLabel.clear()
    this.outgoing.clear()
    this.byOwner.clear()
    await this.load()
    return { changeId: change.id }
  }

  private async applySplit(proposal: ConceptProposal, beforeSnapshot?: GraphSnapshot): Promise<{ changeId: string } | null> {
    const source = this.byId.get(proposal.conceptId ?? '')
    if (!source || source.row.kind !== 'concept' || source.row.valid_to) return null
    const groups = proposal.payload?.groups?.filter((group) => Array.isArray(group) && group.length > 0) ?? []
    if (groups.length < 2) return null
    const before = JSON.stringify(beforeSnapshot ?? await this.snapshotGraph())
    for (let index = 0; index < groups.length; index += 1) {
      const concept = await this.neuron(`${source.row.label}:split${index + 1}`, 'concept')
      for (const episodeId of groups[index]!) {
        const episode = await this.episodes.get(episodeId)
        if (!episode || episode.valid_to) continue
        const tokens = (this.byOwner.get(episodeId) ?? [])
          .map((row) => this.byId.get(row.neuron_id))
          .filter((item): item is RuntimeNeuron => item !== undefined && item.row.kind === 'token')
        for (const token of tokens) {
          await this.link(token.row.id, concept.id, 0.4)
          await this.link(concept.id, token.row.id, 0.2)
        }
        const exists = this.byOwner.get(episodeId)?.some((row) => row.neuron_id === concept.id)
        if (!exists) {
          const binding = await this.bindings.insert({
            owner_id: episodeId,
            owner_kind: 'episode',
            neuron_id: concept.id,
            weight: 0.7,
            position: 999,
          })
          const list = this.byOwner.get(episodeId) ?? []
          list.push(binding)
          this.byOwner.set(episodeId, list)
        }
      }
    }
    await this.neurons.update(source.row.id, { valid_to: Date.now() })
    const after = JSON.stringify(await this.snapshotGraph())
    const change = await this.changes.insert({
      kind: 'split',
      proposal_json: JSON.stringify(proposal),
      before_json: before,
      after_json: after,
      status: 'applied',
      created_at: Date.now(),
    })
    this.byId.clear()
    this.byLabel.clear()
    this.outgoing.clear()
    this.byOwner.clear()
    await this.load()
    return { changeId: change.id }
  }

  async rollbackConceptChange(changeId: string): Promise<boolean> {
    await this.ready
    const change = await this.changes.get(changeId)
    if (!change || change.status !== 'applied') return false
    await this.restoreGraph(JSON.parse(change.before_json) as GraphSnapshot)
    await this.changes.update(changeId, { status: 'rolled_back' })
    return true
  }

  async conceptChanges(limit = 20): Promise<ConceptChangeSummary[]> {
    await this.ready
    return (await this.changes.find({}))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        createdAt: new Date(row.created_at),
        proposal: parseJson(row.proposal_json),
      }))
  }

  async rollbackConceptChanges(changeIds: string[]): Promise<{ rolled: number }> {
    let rolled = 0
    for (const id of [...new Set(changeIds)]) {
      if (await this.rollbackConceptChange(id)) rolled += 1
    }
    return { rolled }
  }

  private async conceptEpisodeSets(): Promise<Map<string, Set<string>>> {
    const sets = new Map<string, Set<string>>()
    for (const [ownerId, bindings] of this.byOwner) {
      const episode = await this.episodes.get(ownerId)
      if (!episode || episode.valid_to) continue
      for (const binding of bindings) {
        const neuron = this.byId.get(binding.neuron_id)
        if (!neuron || neuron.row.kind !== 'concept' || neuron.row.valid_to) continue
        const set = sets.get(binding.neuron_id) ?? new Set<string>()
        set.add(ownerId)
        sets.set(binding.neuron_id, set)
      }
    }
    return sets
  }

  private async snapshotGraph(): Promise<GraphSnapshot> {
    return {
      neurons: await this.neurons.find({}),
      synapses: await this.synapses.find({}),
      bindings: await this.bindings.find({}),
    }
  }

  private async restoreGraph(snapshot: GraphSnapshot): Promise<void> {
    await this.restoreRows(this.neurons, snapshot.neurons)
    await this.restoreRows(this.synapses, snapshot.synapses)
    await this.restoreRows(this.bindings, snapshot.bindings)
    this.byId.clear()
    this.byLabel.clear()
    this.outgoing.clear()
    this.byOwner.clear()
    await this.load()
  }

  private async restoreRows<T extends Row>(collection: Collection<T>, rows: T[]): Promise<void> {
    const current = await collection.find({})
    const wanted = new Map(rows.map((row) => [row.id, row]))
    for (const row of current) if (!wanted.has(row.id)) await collection.delete(row.id)
    for (const row of rows) {
      const existing = await collection.get(row.id)
      if (existing) await collection.update(row.id, row)
      else await collection.insert(row)
    }
  }

  async stats(): Promise<{ neurons: number; synapses: number; episodes: number; facts: number; concepts: number }> {
    await this.ready
    return {
      neurons: this.byId.size,
      synapses: [...this.outgoing.values()].reduce((sum, list) => sum + list.filter((row) => !row.valid_to).length, 0),
      episodes: (await this.episodes.find({})).filter((row) => !row.valid_to).length,
      facts: (await this.facts.find({})).filter((row) => !row.valid_to).length,
      concepts: [...this.byId.values()].filter((item) => item.row.kind === 'concept' && !item.row.valid_to).length,
    }
  }
}

interface GraphSnapshot {
  neurons: NeuronRow[]
  synapses: SynapseRow[]
  bindings: BindingRow[]
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
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
