/**
 * @qingmei/qm-thread —— 跨端任务/话题的缝合点（docs/10 N+ 最小版）。
 *
 * 一个 thread 把对话（conversationId）与任务（taskId）串起来，带一句总结。
 * 其它端按 conversationId/taskId 查同一个 thread，就能回答「那个进展怎么样」。
 */
import type { Context } from 'cordis'
import {
  ThreadService,
  uid,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type Row,
  type StoreService,
  type ThreadRecord,
} from '@qingmei/core'

export const name = 'qm-thread'
export const inject = ['store', 'gateway']

interface ThreadRow extends Row {
  title: string
  status: 'open' | 'closed'
  conversation_ids_json: string
  task_ids_json: string
  summary: string | null
  created_at: number
  updated_at: number
}

class SqliteThreads extends ThreadService {
  private readonly collection

  constructor(ctx: Context, store: StoreService) {
    super(ctx)
    this.collection = store.collection<ThreadRow>('qm_thread')
  }

  async create(input: {
    title: string
    conversationId?: string
    taskId?: string
    summary?: string
  }): Promise<ThreadRecord> {
    const title = String(input.title ?? '').trim().slice(0, 120)
    if (!title) throw new Error('title 不能为空')
    const now = Date.now()
    const row: ThreadRow = {
      id: uid('thread'),
      title,
      status: 'open',
      conversation_ids_json: JSON.stringify(unique([input.conversationId])),
      task_ids_json: JSON.stringify(unique([input.taskId])),
      summary: typeof input.summary === 'string' ? input.summary.trim().slice(0, 2000) : null,
      created_at: now,
      updated_at: now,
    }
    const inserted = await this.collection.insert(row)
    return toThread(inserted)
  }

  async get(id: string): Promise<ThreadRecord | null> {
    const row = await this.collection.get(id)
    return row ? toThread(row) : null
  }

  async list(query: {
    status?: 'open' | 'closed'
    conversationId?: string
    taskId?: string
    limit?: number
  } = {}): Promise<ThreadRecord[]> {
    const rows = (await this.collection.find({}))
      .filter((row) => (query.status ? row.status === query.status : true))
      .filter((row) =>
        query.conversationId ? parseIds(row.conversation_ids_json).includes(query.conversationId) : true,
      )
      .filter((row) => (query.taskId ? parseIds(row.task_ids_json).includes(query.taskId) : true))
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, Math.min(100, Math.max(1, query.limit ?? 20)))
    return rows.map(toThread)
  }

  async link(
    id: string,
    input: { conversationId?: string; taskId?: string; summary?: string; status?: 'open' | 'closed' },
  ): Promise<ThreadRecord | null> {
    const row = await this.collection.get(id)
    if (!row) return null
    const conversations = unique([...parseIds(row.conversation_ids_json), input.conversationId])
    const tasks = unique([...parseIds(row.task_ids_json), input.taskId])
    await this.collection.update(id, {
      conversation_ids_json: JSON.stringify(conversations),
      task_ids_json: JSON.stringify(tasks),
      ...(typeof input.summary === 'string' ? { summary: input.summary.trim().slice(0, 2000) } : {}),
      ...(input.status ? { status: input.status } : {}),
      updated_at: Date.now(),
    })
    return this.get(id)
  }
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))].slice(0, 50)
}

function parseIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function toThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    conversationIds: parseIds(row.conversation_ids_json),
    taskIds: parseIds(row.task_ids_json),
    ...(row.summary ? { summary: row.summary } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export function apply(ctx: Context): void {
  const store = ctx.store
  const gateway = ctx.gateway
  const threads = new SqliteThreads(ctx, store)

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/threads',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const status = req.query.status === 'closed' ? 'closed' : req.query.status === 'open' ? 'open' : undefined
        res.status(200).send({
          ok: true,
          items: await threads.list({
            ...(status ? { status } : {}),
            ...(req.query.conversationId ? { conversationId: req.query.conversationId.trim() } : {}),
            ...(req.query.taskId ? { taskId: req.query.taskId.trim() } : {}),
          }),
        })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/threads',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        try {
          const thread = await threads.create({
            title: String(body.title ?? ''),
            conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
            taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
            summary: typeof body.summary === 'string' ? body.summary : undefined,
          })
          res.status(200).send({ ok: true, thread })
        } catch (error) {
          res.status(400).send({ ok: false, error: error instanceof Error ? error.message : '创建失败' })
        }
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/threads/link',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const thread = await threads.link(id, {
          ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
          ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
          ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
          ...(body.status === 'open' || body.status === 'closed' ? { status: body.status } : {}),
        })
        res.status(thread ? 200 : 404).send(thread ? { ok: true, thread } : { ok: false, error: '没有这个 thread' })
      },
    }),
  )
}

export default { name, inject, apply }
