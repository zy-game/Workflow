/**
 * @qingmei/qm-content —— 内容层的领域模型（纯函数，可单测）。
 *
 * 一条内容（content_item）分叉成各平台的形态（variant）；状态机只在这里定义，
 * 平台适配（render）也是纯函数：同一份 item 进来，确定的 variant 出去。
 * 账号不抽象、内容抽象——见 docs/18-账号运维.md §2 / §6。
 */
import type { Row } from '@qingmei/core'

export const PLATFORMS = ['blog', 'weibo', 'bilibili', 'zhihu'] as const
export type Platform = (typeof PLATFORMS)[number]

export type ItemStatus =
  | 'idea'
  | 'drafting'
  | 'drafted'
  | 'reviewing'
  | 'approved'
  | 'published'
  | 'archived'
  | 'rejected'

export type VariantStatus = 'pending' | 'rendering' | 'ready' | 'scheduled' | 'publishing' | 'live' | 'failed'

/** 素材分级（docs/18 §9.6）：work / life 未脱敏、未逐条授权时不许进内容库 */
export type MaterialLevel = 'public' | 'work' | 'life'

export interface ContentItem extends Row {
  title: string
  body: string
  source: MaterialLevel
  tags: string[]
  status: ItemStatus
  rejectReason: string | null
  createdAt: string
  updatedAt: string
}

export interface ContentVariant extends Row {
  itemId: string
  platform: Platform
  /** 平台内的形态：article / post / dynamic / answer */
  kind: string
  title: string
  body: string
  status: VariantStatus
  /** render() 给出的规则提示，例如「微博已截断到 140 字」 */
  notes: string[]
  error: string | null
  createdAt: string
  updatedAt: string
}

export type ActionResult = 'ok' | 'blocked' | 'failed' | 'info'

export interface ContentAction extends Row {
  itemId: string
  variantId: string | null
  action: string
  result: ActionResult
  actor: string
  detail: string
  at: string
}

/** 非法状态迁移。接口层映射成 409，不重试 */
export class ContentStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentStateError'
  }
}

const ITEM_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  idea: ['drafting', 'archived'],
  drafting: ['drafted', 'archived'],
  drafted: ['reviewing', 'archived'],
  reviewing: ['approved', 'rejected'],
  approved: ['published', 'archived'],
  published: ['archived'],
  rejected: ['drafting', 'archived'],
  archived: [],
}

/** 允许编辑内容的阶段：已提交人审之后改动会让审批失去意义 */
export const EDITABLE_ITEM_STATUSES: ItemStatus[] = ['idea', 'drafting', 'drafted', 'rejected']

export function canTransitionItem(from: ItemStatus, to: ItemStatus): boolean {
  return ITEM_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertItemTransition(from: ItemStatus, to: ItemStatus): void {
  if (!canTransitionItem(from, to)) {
    throw new ContentStateError(`内容状态不能从 ${from} 迁移到 ${to}`)
  }
}

const VARIANT_TRANSITIONS: Record<VariantStatus, VariantStatus[]> = {
  pending: ['rendering', 'failed'],
  rendering: ['ready', 'failed'],
  ready: ['scheduled', 'failed'],
  scheduled: ['publishing', 'failed'],
  publishing: ['live', 'failed'],
  failed: ['pending'],
  live: [],
}

export function canTransitionVariant(from: VariantStatus, to: VariantStatus): boolean {
  return VARIANT_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertVariantTransition(from: VariantStatus, to: VariantStatus): void {
  if (!canTransitionVariant(from, to)) {
    throw new ContentStateError(`平台形态状态不能从 ${from} 迁移到 ${to}`)
  }
}

// ────────────────────────────────────────────── 平台形态：render()

export interface RenderInput {
  title: string
  body: string
  tags: string[]
}

export interface RenderResult {
  kind: string
  title: string
  body: string
  notes: string[]
}

export const WEIBO_LIMIT = 140
export const BILI_DYNAMIC_LIMIT = 2000
export const ZHIHU_MIN_BODY = 200

function plain(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function firstParagraph(text: string): string {
  const parts = plain(text)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
  return parts[0] ?? ''
}

function topicLine(tags: string[]): string {
  return tags
    .filter(Boolean)
    .slice(0, 3)
    .map((tag) => `#${tag.replace(/^#+|#+$/g, '')}#`)
    .join(' ')
}

/**
 * 形态转换：规则，不是创作。
 *
 * 同一份内容到各平台必须长成各自的样子（docs/18 §2.3）；这里只做确定的裁剪与排版，
 * 不做改写——改写属于她的声线，不写死在代码里。
 */
export function renderVariant(item: RenderInput, platform: Platform): RenderResult {
  switch (platform) {
    case 'blog': {
      const notes: string[] = []
      if (plain(item.body).length < 200) notes.push('长文偏短，博客可以展开背景与结论')
      return { kind: 'article', title: item.title.trim(), body: item.body.trim(), notes }
    }
    case 'weibo': {
      const tagLine = topicLine(item.tags)
      const paragraph = firstParagraph(item.body)
      const available = Math.max(0, WEIBO_LIMIT - (tagLine ? tagLine.length + 1 : 0))
      const truncated = paragraph.length > available
      const text = truncated ? `${paragraph.slice(0, Math.max(0, available - 1))}…` : paragraph
      const notes: string[] = []
      if (truncated) notes.push(`微博 ${WEIBO_LIMIT} 字上限，已截取首段`)
      if (!paragraph) notes.push('正文为空，微博没有可发的一句话')
      return { kind: 'post', title: item.title.trim(), body: [text, tagLine].filter(Boolean).join('\n'), notes }
    }
    case 'bilibili': {
      const body = plain(item.body)
      const merged = [body, topicLine(item.tags)].filter(Boolean).join('\n\n')
      const notes: string[] = []
      if (merged.length > BILI_DYNAMIC_LIMIT) notes.push(`B站动态上限 ${BILI_DYNAMIC_LIMIT} 字，已截断`)
      if (!body) notes.push('正文为空，动态没有内容')
      return {
        kind: 'dynamic',
        title: item.title.trim(),
        body: merged.slice(0, BILI_DYNAMIC_LIMIT),
        notes,
      }
    }
    case 'zhihu': {
      const body = plain(item.body)
      const notes: string[] = []
      if (!item.title.trim()) notes.push('知乎需要先选一个问题作为标题')
      if (body.length < ZHIHU_MIN_BODY) notes.push(`答案偏短（${body.length}/${ZHIHU_MIN_BODY} 字），知乎读者更挑剔`)
      return { kind: 'answer', title: item.title.trim(), body, notes }
    }
  }
}

// ────────────────────────────────────────────── 跨平台重复句检查（§2.3）

function splitSentences(text: string): string[] {
  return plain(text)
    .split(/[。！？!?；;\n]+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** 同一句话出现在两个平台上就是 bug：允许共享事实，不允许共享句子 */
export function sharedSentences(
  variants: Array<{ platform: string; body: string }>,
): Array<{ sentence: string; platforms: string[] }> {
  const bySentence = new Map<string, string[]>()
  for (const variant of variants) {
    for (const sentence of splitSentences(variant.body)) {
      if (sentence.length < 20) continue
      const platforms = bySentence.get(sentence) ?? []
      if (!platforms.includes(variant.platform)) platforms.push(variant.platform)
      bySentence.set(sentence, platforms)
    }
  }
  return [...bySentence.entries()]
    .filter(([, platforms]) => platforms.length > 1)
    .map(([sentence, platforms]) => ({ sentence, platforms }))
}

// ────────────────────────────────────────────── 闸门与预算（§7）

export interface GateConfig {
  daily: { publish: number; reply: number; mention: number }
  quietStart: number
  quietEnd: number
  connected: Record<Platform, boolean>
}

export const DEFAULT_GATES: GateConfig = {
  daily: { publish: 2, reply: 20, mention: 10 },
  quietStart: 23,
  quietEnd: 8,
  connected: { blog: false, weibo: false, bilibili: false, zhihu: false },
}

export interface GateStatus {
  at: string
  quiet: boolean
  quietWindow: string
  budgets: Array<{ action: 'publish' | 'reply' | 'mention'; label: string; used: number; limit: number; remaining: number }>
  platforms: Array<{ platform: Platform; connected: boolean }>
  canPublish: boolean
  reasons: string[]
}

const BUDGET_LABELS = { publish: '发布', reply: '评论回复', mention: '@ 回复' } as const

export function gateStatus(config: GateConfig, actions: ContentAction[], now = new Date()): GateStatus {
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const used = { publish: 0, reply: 0, mention: 0 }
  for (const action of actions) {
    if (action.result !== 'ok') continue
    const at = new Date(action.at)
    if (Number.isNaN(at.getTime()) || at < dayStart) continue
    if (action.action === 'publish' || action.action === 'reply' || action.action === 'mention') {
      used[action.action] += 1
    }
  }

  const budgets = (['publish', 'reply', 'mention'] as const).map((action) => ({
    action,
    label: BUDGET_LABELS[action],
    used: used[action],
    limit: config.daily[action],
    remaining: Math.max(0, config.daily[action] - used[action]),
  }))

  const hour = now.getHours()
  const quiet =
    config.quietStart > config.quietEnd
      ? hour >= config.quietStart || hour < config.quietEnd
      : hour >= config.quietStart && hour < config.quietEnd

  const platforms = PLATFORMS.map((platform) => ({ platform, connected: config.connected[platform] }))
  const reasons: string[] = []
  if (quiet) reasons.push(`静默时段 ${config.quietStart}:00–${config.quietEnd}:00`)
  if (budgets[0]!.remaining === 0) reasons.push('今日发布预算已用完')
  if (!platforms.some((item) => item.connected)) reasons.push('还没有接入任何平台账号')

  return {
    at: now.toISOString(),
    quiet,
    quietWindow: `${config.quietStart}:00–${config.quietEnd}:00`,
    budgets,
    platforms,
    canPublish: !quiet && budgets[0]!.remaining > 0 && platforms.some((item) => item.connected),
    reasons,
  }
}

/** 内容级 published 只要求至少一个 variant 上线（§6） */
export function hasLiveVariant(variants: ContentVariant[]): boolean {
  return variants.some((variant) => variant.status === 'live')
}
