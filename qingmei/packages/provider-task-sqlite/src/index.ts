/**
 * @qingmei/provider-task-sqlite —— 任务账本（`qm_task_run`）。
 *
 * 只做记账与状态机，不负责执行：执行在 `qm-task` 里，
 * 子 agent 的进度通过 MCP 工具（`qm_report_progress` / `qm_finish_task`）回到这里。
 *
 * 状态机（docs/07 §5）：
 *   queued → running ⇄ needs_approval → done | failed | cancelled
 * 不允许跳步；已结束的 run 不接受新的进度或再次收尾。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  TaskService,
  uid,
  type CreateTaskInput,
  type Row,
  type StoreService,
  type TaskProgress,
  type TaskRun,
  type TaskStatus,
} from '@qingmei/core'

export interface TaskConfig {
  /** run 目录的根；实际目录是 <workspaceRoot>/<runId> */
  workspaceRoot?: string
  /** 单次执行默认给哪个 harness */
  harnessId?: string
  /** 列表默认条数 */
  listLimit?: number
}

export const name = 'provider-task-sqlite'
export const inject = ['store']

const COLLECTION = 'qm_task_run'
const DEFAULT_WORKSPACE_ROOT = './data/workspaces'
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100
const RUNNING: TaskStatus[] = ['queued', 'running', 'needs_approval']

interface TaskRow extends Row {
  task_id: string
  title: string
  prompt: string
  harness_id: string
  session_id: string | null
  cwd: string
  status: TaskStatus
  progress_json: string | null
  result: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

export class SqliteTask extends TaskService {
  private readonly ctx: Context
  private readonly collection
  private readonly workspaceRoot: string
  private readonly harnessId: string
  private readonly listLimit: number

  constructor(ctx: Context, config: TaskConfig = {}) {
    super(ctx)
    this.ctx = ctx
    const store = ctx.reflect.get('store', false) as StoreService | undefined
    if (!store) throw new Error('[provider-task-sqlite] 缺少 store 服务')
    this.collection = store.collection<TaskRow>(COLLECTION)
    this.workspaceRoot = config.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT
    this.harnessId = config.harnessId ?? 'dsh'
    this.listLimit = config.listLimit ?? DEFAULT_LIST_LIMIT
  }

  async create(input: CreateTaskInput): Promise<TaskRun> {
    const prompt = input.prompt?.trim()
    if (!prompt) throw new Error('任务内容不能为空')
    const id = uid('run')
    const now = Date.now()
    const row: Omit<TaskRow, 'id'> = {
      task_id: id,
      title: input.title?.trim() || prompt.slice(0, 40),
      prompt,
      harness_id: input.harnessId ?? this.harnessId,
      session_id: null,
      cwd: input.cwd ?? `${this.workspaceRoot}/${id}`,
      status: 'queued',
      progress_json: null,
      result: null,
      error: null,
      created_at: now,
      started_at: null,
      finished_at: null,
    }
    const inserted = await this.collection.insert({ ...row, id })
    return toRun(inserted)
  }

  async get(id: string): Promise<TaskRun | null> {
    const row = await this.collection.get(id)
    return row ? toRun(row) : null
  }

  async list(limit?: number): Promise<TaskRun[]> {
    const rows = await this.collection.find()
    const take = Math.min(MAX_LIST_LIMIT, Math.max(1, limit ?? this.listLimit))
    return rows.sort((a, b) => b.created_at - a.created_at).slice(0, take).map(toRun)
  }

  async start(id: string, patch: { sessionId?: string } = {}): Promise<TaskRun | null> {
    const row = await this.collection.get(id)
    if (!row || row.finished_at !== null) return null
    if (row.status === 'running') return toRun(row)
    if (!RUNNING.includes(row.status)) return null
    return this.patch(row, {
      status: 'running',
      started_at: row.started_at ?? Date.now(),
      session_id: patch.sessionId ?? row.session_id,
    }, EVENTS.taskRunStarted)
  }

  async setStatus(id: string, status: 'running' | 'needs_approval'): Promise<TaskRun | null> {
    const row = await this.collection.get(id)
    if (!row || row.finished_at !== null) return null
    return this.patch(row, { status })
  }

  async reportProgress(
    id: string,
    progress: { phase: string; percent?: number; note?: string },
  ): Promise<TaskRun | null> {
    const row = await this.collection.get(id)
    if (!row || row.finished_at !== null) return null
    const phase = progress.phase?.trim()
    if (!phase) throw new Error('进度必须有 phase')

    const entry: TaskProgress = {
      phase,
      at: new Date(),
      ...(Number.isFinite(progress.percent) ? { percent: progress.percent } : {}),
      ...(progress.note?.trim() ? { note: progress.note.trim() } : {}),
    }
    const next = await this.patch(row, { progress_json: JSON.stringify(entry) })
    if (next) this.ctx.events.emit(EVENTS.taskProgress, next)
    return next
  }

  async finish(
    id: string,
    input: { status: 'done' | 'failed' | 'cancelled'; result?: string; error?: string },
  ): Promise<TaskRun | null> {
    const row = await this.collection.get(id)
    if (!row) return null
    if (row.finished_at !== null) return toRun(row)

    const next = await this.patch(row, {
      status: input.status,
      result: input.result ?? row.result,
      error: input.error ?? row.error,
      finished_at: Date.now(),
    })
    if (next) this.ctx.events.emit(EVENTS.taskFinished, next)
    return next
  }

  private async patch(row: TaskRow, changes: Partial<TaskRow>, event?: string): Promise<TaskRun | null> {
    await this.collection.update(row.id, changes)
    const updated = await this.collection.get(row.id)
    if (!updated) return null
    const run = toRun(updated)
    if (event) this.ctx.events.emit(event, run)
    return run
  }
}

function toRun(row: TaskRow): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    prompt: row.prompt,
    harnessId: row.harness_id,
    sessionId: row.session_id,
    cwd: row.cwd,
    status: row.status,
    progress: parseProgress(row.progress_json),
    result: row.result,
    error: row.error,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at === null ? null : new Date(row.started_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
  }
}

function parseProgress(raw: string | null): TaskProgress | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { phase?: string; percent?: number; note?: string; at?: string }
    if (typeof parsed.phase !== 'string') return null
    return {
      phase: parsed.phase,
      ...(typeof parsed.percent === 'number' ? { percent: parsed.percent } : {}),
      ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
      at: parsed.at ? new Date(parsed.at) : new Date(),
    }
  } catch {
    return null
  }
}

export function apply(ctx: Context, config: TaskConfig = {}): void {
  ctx.plugin(SqliteTask, config)
}

export const defaultExport = { name, inject, apply }
