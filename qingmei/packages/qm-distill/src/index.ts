/**
 * @qingmei/qm-distill —— 会话记忆凝练。
 *
 * 触发点在 `qm/turn/end`（不是每轮都调模型）：
 *   1. 只处理 owner 私聊、且回合成功的用户发言；
 *   2. 先跑规则抽取（extract.ts），命中就落「候选事实」；
 *   3. 可选 LLM 抽取，默认关闭，有每日配额；
 *   4. 候选不会直接进记忆——主人采纳后才 ingest，可批量回滚。
 *
 * 为什么是候选队列而不是直接写记忆：召回是自动的，写错一条会污染很久；
 * 让人点一下，成本远低于事后纠错。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  uid,
  type AuditService,
  type Collection,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type LlmService,
  type MemoryRecord,
  type MemoryService,
  type Row,
  type StoreService,
  type TurnEnd,
} from '@qingmei/core'
import { extractCandidates, type FactCandidate } from './extract.ts'
import { extractLearnings, type LearningCandidate } from './learn.ts'

export interface DistillConfig {
  /** 总开关，默认 true */
  enabled?: boolean
  /** 待确认队列上限，超过就不再新增，默认 200 */
  maxPending?: number
  /** 低于该置信度的候选丢弃，默认 0.5 */
  minConfidence?: number
  /** 是否用模型补抽（默认 false；打开前先确认 LLM 已配置） */
  llmExtract?: boolean
  /** 模型抽取每天最多几条消息，默认 20 */
  llmDailyLimit?: number
}

export const name = 'qm-distill'
export const inject = ['store', 'gateway', 'memory']

const CANDIDATES = 'qm_memory_candidate'
const QUOTA = 'qm_distill_quota'
const DEFAULT_MAX_PENDING = 200
const DEFAULT_MIN_CONFIDENCE = 0.5
const DEFAULT_LLM_DAILY_LIMIT = 20

type CandidateStatus = 'pending' | 'accepted' | 'rejected' | 'rolled_back'

interface CandidateRow extends Row {
  /** 缺省 fact：老数据没有这个字段 */
  kind?: 'fact' | 'lesson' | 'decision'
  /** 教训/决策的原文 */
  text?: string
  subject: string
  predicate: string
  object: string
  confidence: number
  rule: string
  status: CandidateStatus
  batch_id: string
  session_id: string
  trace_id: string | null
  fact_id: string | null
  created_at: number
  decided_at: number | null
  reason?: string | null
}

interface QuotaRow extends Row {
  day: string
  count: number
}

export function apply(ctx: Context, config: DistillConfig = {}): void {
  const store = ctx.store as StoreService
  const gateway = ctx.gateway as GatewayService
  const memory = ctx.memory as MemoryService
  const minConfidence = Number.isFinite(config.minConfidence) ? Number(config.minConfidence) : DEFAULT_MIN_CONFIDENCE
  const maxPending = Number.isFinite(config.maxPending) ? Math.max(1, Number(config.maxPending)) : DEFAULT_MAX_PENDING
  const llmDailyLimit = Number.isFinite(config.llmDailyLimit)
    ? Math.max(0, Number(config.llmDailyLimit))
    : DEFAULT_LLM_DAILY_LIMIT
  const enabled = config.enabled !== false
  let audit: AuditService | undefined
  ctx.inject(['audit'], (sub) => { audit = sub.audit })

  const candidates = store.collection<CandidateRow>(CANDIDATES)
  const quota = store.collection<QuotaRow>(QUOTA)
  let distillChain: Promise<unknown> = Promise.resolve()

  async function auditDecision(entry: {
    action: string
    decision: 'allow' | 'deny'
    row: CandidateRow
    detail?: Record<string, unknown>
  }): Promise<void> {
    await audit
      ?.append({
        at: new Date(),
        actorId: 'owner',
        channel: 'web',
        action: entry.action,
        target: entry.row.id,
        decision: entry.decision,
        detail: { subject: entry.row.subject, predicate: entry.row.predicate, object: entry.row.object, rule: entry.row.rule, ...entry.detail },
        traceId: entry.row.trace_id ?? entry.row.id,
      })
      .catch(() => undefined)
  }

  async function takeLlmQuota(): Promise<boolean> {
    if (llmDailyLimit <= 0) return false
    const day = new Date().toISOString().slice(0, 10)
    const existing = await quota.get(day)
    const used = existing?.count ?? 0
    if (used >= llmDailyLimit) return false
    if (existing) await quota.update(day, { count: used + 1 })
    else await quota.insert({ id: day, day, count: 1 })
    return true
  }

  async function llmDrafts(text: string): Promise<FactCandidate[]> {
    if (config.llmExtract !== true) return []
    const llm = ctx.get('llm', false) as LlmService | undefined
    if (!llm) return []
    if (!(await takeLlmQuota())) return []
    let raw = ''
    try {
      for await (const chunk of llm.chat({
        messages: [
          {
            role: 'system',
            content:
              '从用户这句话里抽取稳定的事实，输出 JSON 数组，元素形如 {"subject":"主人","predicate":"喜欢","object":"手冲咖啡"}。' +
              '只抽长期有效的信息（偏好、住址、人物、习惯、约定），不抽一次性闲聊；没有就输出 []。不要解释。',
          },
          { role: 'user', content: text },
        ],
      })) {
        if (chunk.type === 'text') raw += chunk.text
      }
    } catch {
      return []
    }
    const start = raw.indexOf('[')
    const end = raw.lastIndexOf(']')
    if (start < 0 || end <= start) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.slice(start, end + 1))
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    const out: FactCandidate[] = []
    for (const item of parsed.slice(0, 5)) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const subject = String(record.subject ?? '主人').trim()
      const predicate = String(record.predicate ?? '').trim()
      const object = String(record.object ?? '').trim()
      if (!predicate || !object || object.length > 40) continue
      out.push({ subject: subject || '主人', predicate, object, confidence: 0.45, rule: 'llm' })
    }
    return out
  }

  /** 统一的入队逻辑：并发下也是串行调用（见 distillChain），查重和配额都在这里 */
  async function enqueue(
    drafts: (FactCandidate | LearningCandidate)[],
    meta: { batchId: string; sessionId: string; traceId: string | null },
  ): Promise<void> {
    if (drafts.length === 0) return
    const pending = await candidates.count({ where: { status: 'pending' } })
    let room = maxPending - pending
    for (const draft of drafts) {
      const learning = 'text' in draft
      const fact = draft as FactCandidate
      const lesson = draft as LearningCandidate
      const subject = learning ? '主人' : fact.subject
      const predicate = learning ? (lesson.kind === 'lesson' ? '教训' : '决策') : fact.predicate
      const object = learning ? lesson.text : fact.object
      if (room <= 0) {
        ctx.logger?.warn?.(`[qm-distill] 待确认队列已满（${maxPending}），丢弃：${predicate}=${object}`)
        break
      }
      const same = await candidates.find({
        where: { subject, predicate, object },
      })
      if (same.some((row) => row.status === 'pending' || row.status === 'accepted')) continue
      await candidates.insert({
        id: uid('cand'),
        ...(learning ? { kind: draft.kind, text: draft.text } : {}),
        subject,
        predicate,
        object,
        confidence: draft.confidence,
        rule: draft.rule,
        status: 'pending',
        batch_id: meta.batchId,
        session_id: meta.sessionId,
        trace_id: meta.traceId,
        fact_id: null,
        created_at: Date.now(),
        decided_at: null,
      })
      room -= 1
    }
  }

  async function onTurnEnd(end: TurnEnd): Promise<void> {
    if (!enabled) return
    if (!end.ok || end.audience !== 'owner') return
    const text = String(end.userText ?? '').trim()
    if (!text) return

    const drafts: (FactCandidate | LearningCandidate)[] = extractCandidates(text).filter(
      (item) => item.confidence >= minConfidence,
    )
    drafts.push(...extractLearnings(text).filter((item) => item.confidence >= minConfidence))
    if (config.llmExtract === true) drafts.push(...(await llmDrafts(text)))
    if (drafts.length === 0) return
    await enqueue(drafts, { batchId: end.traceId, sessionId: end.sessionId, traceId: end.traceId })
  }

  /** 手动会话（DSH GUI / 手动 ACP）收尾：只走规则，不调模型；来源记成 device:<id> */
  async function onSessionIngested(input: {
    deviceId?: string
    sessionId?: string
    summary?: string
    turns?: { role?: string; text?: string; at?: number }[]
  }): Promise<void> {
    if (!enabled) return
    const deviceId = String(input.deviceId ?? '').trim()
    const sessionId = String(input.sessionId ?? '').trim()
    if (!deviceId || !sessionId) return
    const texts = (input.turns ?? [])
      .filter((turn) => turn?.role === 'user' && typeof turn.text === 'string')
      .map((turn) => String(turn.text).trim())
      .filter(Boolean)
      .slice(-50)
    if (texts.length === 0) return

    const seen = new Set<string>()
    const drafts: (FactCandidate | LearningCandidate)[] = []
    for (const text of texts) {
      for (const draft of extractCandidates(text)) {
        if (draft.confidence < minConfidence) continue
        const key = `${draft.subject}|${draft.predicate}|${draft.object}`
        if (seen.has(key)) continue
        seen.add(key)
        drafts.push(draft)
      }
      for (const learning of extractLearnings(text)) {
        if (learning.confidence < minConfidence) continue
        const key = `${learning.kind}|${learning.text}`
        if (seen.has(key)) continue
        seen.add(key)
        drafts.push(learning)
      }
    }
    await enqueue(drafts, {
      batchId: `ingest:${deviceId}:${sessionId}`,
      sessionId: deviceId,
      traceId: null,
    })

    // 摘要本身也落一条 episode：即使没有可抽的事实，「在 DSH 里做过什么」也要能被召回
    // 逐轮落 episode：细节比一句摘要更不容易失真；摘要只在没有轮次时兜底
    const turns = (input.turns ?? []).filter(
      (turn): turn is { role?: string; text: string; at?: number } =>
        typeof turn?.text === 'string' && turn.text.trim().length > 0,
    )
    const episodes: MemoryRecord[] = []
    for (let index = 0; index < turns.length && episodes.length < 20; index += 1) {
      const turn = turns[index]!
      if (turn.role !== 'user') continue
      const reply = turns[index + 1]?.role === 'assistant' ? turns[index + 1] : undefined
      const text = `主人：${turn.text.trim()}${reply ? `\n青梅：${reply.text.trim()}` : ''}`.slice(0, 2000)
      episodes.push({
        kind: 'episode',
        subject: `device:${deviceId}`,
        predicate: '会话',
        object: text,
        confidence: 0.7,
        salience: 0.45,
        sensitivity: 'private',
        audience: 'owner',
        origin: { kind: 'doc', id: `${deviceId}:${sessionId}:${index}` },
        occurredAt: turn.at ? new Date(turn.at) : new Date(),
      })
    }
    if (episodes.length === 0) {
      const fallback = (String(input.summary ?? '').trim() || texts.join('\n')).slice(0, 2000)
      if (fallback) {
        episodes.push({
          kind: 'episode',
          subject: `device:${deviceId}`,
          predicate: '会话',
          object: fallback,
          confidence: 0.7,
          salience: 0.4,
          sensitivity: 'private',
          audience: 'owner',
          origin: { kind: 'doc', id: `${deviceId}:${sessionId}` },
          occurredAt: new Date(),
        })
      }
    }
    if (episodes.length > 0) await memory.ingest(episodes)
  }

  ctx.events.on(EVENTS.turnEnd, (end: TurnEnd) => {
    // 串行化：两条并发回合如果同时查重再插入，会各插一条重复候选
    distillChain = distillChain
      .then(() => onTurnEnd(end))
      .catch((error) => {
        ctx.logger?.warn?.(`[qm-distill] 凝练失败：${error instanceof Error ? error.message : String(error)}`)
      })
  })

  ctx.events.on(EVENTS.sessionIngested, (input: { deviceId?: string; sessionId?: string; turns?: { role?: string; text?: string }[] }) => {
    distillChain = distillChain
      .then(() => onSessionIngested(input))
      .catch((error) => {
        ctx.logger?.warn?.(`[qm-distill] 会话凝练失败：${error instanceof Error ? error.message : String(error)}`)
      })
  })

  // 关系图查询：GET /api/v1/memory/graph?name=主人&depth=2
  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/memory/graph',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const name = String(req.query.name ?? '').trim()
        if (!name) {
          res.status(400).send({ ok: false, error: 'name 必填' })
          return
        }
        const depth = Math.min(2, Math.max(1, Number(req.query.depth) || 1))
        const result = await memory.neighbors(name, { depth })
        res.status(200).send({ ok: true, ...result })
      },
    }),
  )
  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/memory/candidates',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const status = String(req.query.status ?? 'pending').trim() as CandidateStatus | 'all'
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
        const rows =
          status === 'all'
            ? await candidates.find({ order: [{ field: 'created_at', dir: 'desc' }], limit })
            : await candidates.find({ where: { status }, order: [{ field: 'created_at', dir: 'desc' }], limit })
        res.status(200).send({ ok: true, items: rows })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/memory/candidates/decide',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id || typeof body.allow !== 'boolean') {
          res.status(400).send({ ok: false, error: 'id 与 allow 必填' })
          return
        }
        const row = await candidates.get(id)
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这条候选' })
          return
        }
        if (row.status !== 'pending') {
          res.status(409).send({ ok: false, error: `候选已是 ${row.status}` })
          return
        }
        if (!body.allow) {
          await candidates.update(id, {
            status: 'rejected',
            decided_at: Date.now(),
            reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : null,
          })
          const next = await candidates.get(id)
          await auditDecision({ action: 'memory.candidate.reject', decision: 'deny', row })
          res.status(200).send({ ok: true, item: next })
          return
        }

        const record: MemoryRecord = {
          kind: row.kind ?? 'fact',
          subject: row.subject,
          predicate: row.predicate,
          object: row.object,
          confidence: Math.max(row.confidence, 0.6),
          sensitivity: 'private',
          audience: 'owner',
          origin: { kind: 'distilled', id: `candidate:${row.id}` },
        }
        const result = await memory.ingest([record])
        const factId = result.created[0] ?? result.merged[0] ?? null
        await candidates.update(id, { status: 'accepted', fact_id: factId, decided_at: Date.now() })
        const next = await candidates.get(id)
        await auditDecision({ action: 'memory.candidate.accept', decision: 'allow', row, detail: { factId } })
        res.status(200).send({ ok: true, item: next, factId })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/memory/candidates/reopen',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const row = await candidates.get(id)
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这条候选' })
          return
        }
        if (row.status !== 'rejected' && row.status !== 'rolled_back') {
          res.status(409).send({ ok: false, error: `候选是 ${row.status}，不需要恢复` })
          return
        }
        await candidates.update(id, { status: 'pending', decided_at: null, fact_id: null })
        const next = await candidates.get(id)
        await auditDecision({ action: 'memory.candidate.reopen', decision: 'allow', row })
        res.status(200).send({ ok: true, item: next })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/memory/candidates/rollback',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const batchId = typeof body.batchId === 'string' ? body.batchId.trim() : ''
        const rows = batchId
          ? await candidates.find({ where: { batch_id: batchId } })
          : await candidates.find({ where: { status: 'accepted' } })
        const accepted = rows.filter((row) => row.status === 'accepted' && row.fact_id)
        if (accepted.length === 0) {
          res.status(200).send({ ok: true, rolledBack: 0 })
          return
        }
        await memory.forget(accepted.map((row) => String(row.fact_id)))
        for (const row of accepted) {
          await candidates.update(row.id, { status: 'rolled_back', decided_at: Date.now() })
          await auditDecision({
            action: 'memory.candidate.rollback',
            decision: 'deny',
            row,
            detail: { factId: row.fact_id },
          })
        }
        res.status(200).send({ ok: true, rolledBack: accepted.length })
      },
    }),
  )
}

export const defaultExport = { name, inject, apply }
export type { FactCandidate }
export { extractCandidates }













