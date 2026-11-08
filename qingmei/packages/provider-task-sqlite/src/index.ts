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
  type TaskArtifact,
  type TaskContract,
  type TaskProgress,
  type TaskRun,
  type TaskStatus,
  type TaskTarget,
  type TaskUsage,
} from '@qingmei/core'

export interface TaskConfig {
  /** run 目录的根；实际目录是 <workspaceRoot>/<runId> */
  workspaceRoot?: string
  /** 本地执行器 id，默认 local */
  executorId?: string
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
  /** 老数据没有这一列 */
  project?: string | null
  /** task = 正常任务；inventory = 只读盘点 */
  kind?: string | null
  /** 0-9，老数据没有这一列 */
  priority?: number
  depends_on_json?: string | null
  /** W1 任务合同；老数据没有 */
  contract_json?: string | null
  /** 唯一执行目标；不再单独存 harness_id/cwd */
  target_json: string
  session_id: string | null
  status: TaskStatus
  progress_json: string | null
  /** 进度事件流；老数据没有 */
  progress_events_json?: string | null
  artifacts_json: string | null
  usage_json: string | null
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
  private readonly executorId: string
  private readonly listLimit: number
  /** 同一毫秒内建的 run 也要有稳定先后（列表排序与测试都依赖它） */
  private lastCreatedAt = 0

  constructor(ctx: Context, config: TaskConfig = {}) {
    super(ctx)
    this.ctx = ctx
    const store = ctx.store
    if (!store) throw new Error('[provider-task-sqlite] 缺少 store 服务')
    this.collection = store.collection<TaskRow>(COLLECTION)
    this.workspaceRoot = config.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT
    this.executorId = config.executorId ?? 'local'
    this.listLimit = config.listLimit ?? DEFAULT_LIST_LIMIT
  }

  async create(input: CreateTaskInput): Promise<TaskRun> {
    const prompt = input.prompt?.trim()
    if (!prompt) throw new Error('任务内容不能为空')
    const id = uid('run')
    const now = Math.max(Date.now(), this.lastCreatedAt + 1)
    this.lastCreatedAt = now
    const target: TaskTarget = {
      executorId: input.target?.executorId?.trim() || this.executorId,
      ...(input.target?.workspaceId?.trim() ? { workspaceId: input.target.workspaceId.trim() } : {}),
      ...(input.target?.sessionKey?.trim() ? { sessionKey: input.target.sessionKey.trim() } : {}),
      cwd: input.target?.cwd?.trim() || `${this.workspaceRoot}/${id}`,
    }
    const row: Omit<TaskRow, 'id'> = {
      task_id: id,
      title: input.title?.trim() || prompt.slice(0, 40),
      prompt,
      project: input.project?.trim() || null,
      kind: input.kind === 'inventory' ? 'inventory' : 'task',
      priority: clampPriority(input.priority),
      depends_on_json: JSON.stringify(normalizeDependsOn(input.dependsOn)),
      contract_json: input.contract ? JSON.stringify(serializeContract(input.contract)) : null,
      target_json: JSON.stringify(target),
      session_id: input.sessionId ?? null,
      status: 'queued',
      progress_json: null,
      progress_events_json: null,
      artifacts_json: null,
      usage_json: null,
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

  async resume(id: string): Promise<TaskRun | null> {
    const row = await this.collection.get(id)
    if (!row) return null
    if (row.status === 'done' || row.status === 'cancelled') return toRun(row)
    return this.patch(row, {
      status: 'queued',
      error: null,
      result: null,
      started_at: null,
      finished_at: null,
    })
  }
  async start(id: string, patch: { sessionId?: string } = {}): Promise<TaskRun | null> {
    const row = await this.collection.get(id)
    if (!row || row.finished_at !== null) return null
    if (row.status === 'running') {
      // 已经在跑：只补记 harness 侧 sessionId（resume 要用）
      if (patch.sessionId && patch.sessionId !== row.session_id) {
        return this.patch(row, { session_id: patch.sessionId })
      }
      return toRun(row)
    }
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
    const history = [...parseProgressHistory(row.progress_events_json), entry].slice(-100)
    const next = await this.patch(row, {
      progress_json: JSON.stringify(entry),
      progress_events_json: JSON.stringify(history),
    })
    if (next) this.ctx.events.emit(EVENTS.taskProgress, next)
    return next
  }

  async addArtifact(
    id: string,
    artifact: { name: string; url?: string; path?: string; summary?: string },
  ): Promise<TaskRun | null> {
    const row = await this.collection.get(id)
    if (!row || row.finished_at !== null) return null
    const name = artifact.name?.trim()
    if (!name) throw new Error('产物必须有 name')

    const entry: TaskArtifact = {
      name,
      at: new Date(),
      ...(artifact.url?.trim() ? { url: artifact.url.trim() } : {}),
      ...(artifact.path?.trim() ? { path: artifact.path.trim() } : {}),
      ...(artifact.summary?.trim() ? { summary: artifact.summary.trim() } : {}),
    }
    const list = parseArtifacts(row.artifacts_json)
    list.push(entry)
    return this.patch(row, { artifacts_json: JSON.stringify(list) })
  }

  /** 用量是累加的：同一个 run 多次上报会相加（一次 prompt 一条） */
  async reportUsage(id: string, usage: TaskUsage): Promise<TaskRun | null> {
    const row = await this.collection.get(id)
    if (!row) return null
    const current = parseUsage(row.usage_json) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    const merged: TaskUsage = {
      inputTokens: current.inputTokens + Math.max(0, usage.inputTokens || 0),
      outputTokens: current.outputTokens + Math.max(0, usage.outputTokens || 0),
      totalTokens: current.totalTokens + Math.max(0, usage.totalTokens || 0),
    }
    return this.patch(row, { usage_json: JSON.stringify(merged) })
  }

  async finish(
    id: string,
    input: { status: 'done' | 'failed' | 'cancelled'; result?: string; error?: string; sessionId?: string },
  ): Promise<TaskRun | null> {
    const row = await this.collection.get(id)
    if (!row) return null
    if (row.finished_at !== null) return toRun(row)

    const next = await this.patch(row, {
      status: input.status,
      result: input.result ?? row.result,
      error: input.error ?? row.error,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
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

function parseArtifacts(raw: string | null): TaskArtifact[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as { name?: string; url?: string; path?: string; summary?: string; at?: string }[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => typeof item?.name === 'string' && item.name)
      .map((item) => ({
        name: item.name!,
        ...(item.url ? { url: item.url } : {}),
        ...(item.path ? { path: item.path } : {}),
        ...(item.summary ? { summary: item.summary } : {}),
        at: item.at ? new Date(item.at) : new Date(),
      }))
  } catch {
    return []
  }
}

function parseUsage(raw: string | null): TaskUsage | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<TaskUsage>
    if (typeof parsed !== 'object' || parsed === null) return null
    return {
      inputTokens: Number(parsed.inputTokens) || 0,
      outputTokens: Number(parsed.outputTokens) || 0,
      totalTokens: Number(parsed.totalTokens) || 0,
    }
  } catch {
    return null
  }
}

function toRun(row: TaskRow): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    prompt: row.prompt,
    project: row.project?.trim() || null,
    kind: row.kind === 'inventory' ? 'inventory' : 'task',
    priority: clampPriority(row.priority),
    dependsOn: parseDependsOn(row.depends_on_json),
    contract: parseContract(row.contract_json),
    target: parseTarget(row.target_json),
    sessionId: row.session_id,
    status: row.status,
    progress: parseProgress(row.progress_json),
    progressHistory: parseProgressHistory(row.progress_events_json),
    artifacts: parseArtifacts(row.artifacts_json),
    usage: parseUsage(row.usage_json),
    result: row.result,
    error: row.error,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at === null ? null : new Date(row.started_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
  }
}

/** 缺省 5，夹在 0..9；老数据按 5 处理 */
function serializeContract(contract: TaskContract): Record<string, unknown> {
  return {
    ...contract,
    ...(contract.deadline ? { deadline: contract.deadline.toISOString() } : {}),
    ...(contract.expected
      ? { expected: contract.expected.map((item) => ({ at: item.at.toISOString(), percent: item.percent })) }
      : {}),
  }
}

function parseContract(raw: string | null | undefined): TaskContract | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      ...(typeof parsed.deadline === 'string' ? { deadline: new Date(parsed.deadline) } : {}),
      ...(typeof parsed.progressSignal === 'string' ? { progressSignal: parsed.progressSignal as TaskContract['progressSignal'] } : {}),
      ...(Array.isArray(parsed.expected)
        ? {
            expected: parsed.expected.map((item) => ({
              at: new Date((item as { at: string }).at),
              percent: Number((item as { percent: number }).percent) || 0,
            })),
          }
        : {}),
      enforcement: (parsed.enforcement as TaskContract['enforcement']) ?? 'firm',
      ...(typeof parsed.tokenBudget === 'number' && parsed.tokenBudget > 0
        ? { tokenBudget: Math.round(parsed.tokenBudget) }
        : {}),
      ...(Array.isArray(parsed.allowedActions) ? { allowedActions: parsed.allowedActions.map(String) } : {}),
      ...(parsed.escape && typeof parsed.escape === 'object'
        ? {
            escape: {
              perDay: Number((parsed.escape as { perDay?: number }).perDay ?? 1),
              hours: Number((parsed.escape as { hours?: number }).hours ?? 2),
            },
          }
        : {}),
    }
  } catch {
    return null
  }
}
function normalizeDependsOn(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
}

function parseDependsOn(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    return normalizeDependsOn(JSON.parse(raw))
  } catch {
    return []
  }
}

function clampPriority(value: unknown): number {
  const priority = Number(value)
  if (!Number.isFinite(priority)) return 5
  return Math.min(9, Math.max(0, Math.round(priority)))
}

function parseTarget(raw: string): TaskTarget {
  try {
    const parsed = JSON.parse(raw) as Partial<TaskTarget>
    const executorId = typeof parsed.executorId === 'string' && parsed.executorId.trim() ? parsed.executorId.trim() : 'local'
    return {
      executorId,
      ...(typeof parsed.workspaceId === 'string' && parsed.workspaceId.trim() ? { workspaceId: parsed.workspaceId.trim() } : {}),
      ...(typeof parsed.sessionKey === 'string' && parsed.sessionKey.trim() ? { sessionKey: parsed.sessionKey.trim() } : {}),
      ...(typeof parsed.cwd === 'string' && parsed.cwd.trim() ? { cwd: parsed.cwd.trim() } : {}),
    }
  } catch {
    return { executorId: 'local' }
  }
}
function parseProgressHistory(raw: string | null | undefined): TaskProgress[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is { phase: string; percent?: number; note?: string; at?: string } => Boolean(item) && typeof item.phase === 'string')
      .map((item) => ({
        phase: item.phase,
        ...(typeof item.percent === 'number' ? { percent: item.percent } : {}),
        ...(typeof item.note === 'string' ? { note: item.note } : {}),
        at: item.at ? new Date(item.at) : new Date(),
      }))
  } catch {
    return []
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
