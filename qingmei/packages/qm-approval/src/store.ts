/**
 * @qingmei/provider-approval-sqlite —— 待人确认的动作队列（`qm_approval`）。
 *
 * 用途是 docs/07 §8 的审批桥：permission 判定 `ask`、或 harness 发来
 * `session/request_permission` 时，落一条记录，等人批准；调用方 `wait()` 等结果。
 * 等待用轮询而不是内存 promise：进程重启后待确认的请求还在，人也还能补批。
 */
import type { Context } from 'cordis'
import {
  ApprovalService,
  EVENTS,
  uid,
  type ApprovalRequest,
  type ApprovalStatus,
  type ChannelId,
  type CreateApprovalInput,
  type Row,
  type StoreService,
} from '@qingmei/core'

export const name = 'provider-approval-sqlite'
export const inject = ['store']

const COLLECTION = 'qm_approval'
const POLL_MS = 200
const DEFAULT_LIST_LIMIT = 50

interface ApprovalRow extends Row {
  action: string
  prompt: string
  status: ApprovalStatus
  run_id: string | null
  requester: string
  channel: string
  created_at: number
  decided_at: number | null
  reason: string | null
}

export class SqliteApproval extends ApprovalService {
  readonly ctx: Context
  /** 同一毫秒内的审批也要有稳定先后 */
  private lastCreatedAt = 0
  private readonly collection

  private nextCreatedAt(): number {
    const now = Math.max(Date.now(), this.lastCreatedAt + 1)
    this.lastCreatedAt = now
    return now
  }

  constructor(ctx: Context) {
    super(ctx)
    this.ctx = ctx
    const store = ctx.store
    if (!store) throw new Error('[provider-approval-sqlite] 缺少 store 服务')
    this.collection = store.collection<ApprovalRow>(COLLECTION)
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRequest> {
    const action = input.action?.trim()
    const prompt = input.prompt?.trim()
    if (!action) throw new Error('审批必须有 action')
    if (!prompt) throw new Error('审批必须有 prompt')

    const row: Omit<ApprovalRow, 'id'> = {
      action,
      prompt,
      status: 'pending',
      run_id: input.runId ?? null,
      requester: input.requester ?? 'unknown',
      channel: input.channel ?? 'web',
      created_at: this.nextCreatedAt(),
      decided_at: null,
      reason: null,
    }
    const inserted = await this.collection.insert(row)
    const request = toRequest(inserted)
    this.ctx.events.emit(EVENTS.approvalRequested, request)
    return request
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    const row = await this.collection.get(id)
    return row ? toRequest(row) : null
  }

  async list(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    const rows = await this.collection.find()
    return rows
      .filter((row) => (status ? row.status === status : true))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, DEFAULT_LIST_LIMIT)
      .map(toRequest)
  }

  async decide(id: string, input: { allow: boolean; reason?: string }): Promise<ApprovalRequest | null> {
    const row = await this.collection.get(id)
    if (!row) return null
    if (row.status !== 'pending') return toRequest(row)

    await this.collection.update(id, {
      status: input.allow ? 'allowed' : 'denied',
      decided_at: Date.now(),
      reason: input.reason?.trim() || null,
    })
    const updated = await this.collection.get(id)
    if (!updated) return null
    const decided = toRequest(updated)
    this.ctx.events.emit(EVENTS.approvalDecided, decided)
    return decided
  }

  async wait(id: string, timeoutMs: number): Promise<ApprovalRequest | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (Date.now() <= deadline) {
      const current = await this.get(id)
      if (!current) return null
      if (current.status !== 'pending') return current
      await sleep(POLL_MS)
    }
    return null
  }
}

function toRequest(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    action: row.action,
    prompt: row.prompt,
    status: row.status,
    runId: row.run_id,
    requester: row.requester,
    channel: row.channel as ChannelId,
    createdAt: new Date(row.created_at),
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at),
    reason: row.reason,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function apply(ctx: Context): void {
  ctx.plugin(SqliteApproval)
}

export const defaultExport = { name, inject, apply }
