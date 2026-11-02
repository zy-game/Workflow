/**
 * @qingmei/qm-task —— 把任务派给 harness 并记账。
 *
 * 职责边界（docs/07）：青梅决定「做什么、什么时候」；harness 决定「怎么做」。
 * 本插件做三件事：
 *   - 提供 `taskRunner` 服务：把某个 run 交给 harness（对话车道可以通过 MCP 工具调用它）
 *   - `POST /api/v1/tasks` 建 run 并派发；`GET /api/v1/tasks[?id=]` 查询
 *   - 把任务状态变化推给 SSE（task-started / task-progress / task-finished）
 *
 * 执行期间子 agent 通过 MCP 工具 `qm_report_progress` / `qm_finish_task` 把进度写回账本。
 * 子 agent 没汇报也不会卡住：会话正常结束就把累计文本当结论收尾。
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import {
  EVENTS,
  TaskRunnerService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type HarnessService,
  type TaskRun,
  type TaskService,
} from '@qingmei/core'

export interface TaskConfig {
  /** run 目录的根；不配则沿用 provider-task-sqlite 的默认值 */
  workspaceRoot?: string
  /** 单次执行的时间上限，默认 10 分钟 */
  timeoutMs?: number
  /** 派给哪个 harness */
  harnessId?: string
}

export const name = 'qm-task'
export const inject = ['task', 'gateway']

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_HARNESS = 'dsh'
const LIST_LIMIT = 20

interface RunnerDeps {
  task: TaskService
  timeoutMs: number
}

export class TaskRunner extends TaskRunnerService {
  private readonly ctx: Context
  private readonly deps: RunnerDeps

  constructor(ctx: Context, deps: RunnerDeps) {
    super(ctx)
    this.ctx = ctx
    this.deps = deps
  }

  /** harness 是可选依赖，且比本插件晚加载——每次派发时再取，不能在建插件时捕获 */
  private harness(): HarnessService | undefined {
    return this.ctx.reflect.get('harness', false) as HarnessService | undefined
  }

  dispatch(run: TaskRun): void {
    void this.execute(run)
  }

  private async execute(run: TaskRun): Promise<void> {
    const { task, timeoutMs } = this.deps
    const harness = this.harness()
    if (!harness) {
      await task.finish(run.id, { status: 'failed', error: '没有可用的 harness' })
      return
    }
    const conversationId = `task_${run.id}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let collected = ''
    let failure: string | null = null

    try {
      const cwd = path.resolve(run.cwd)
      await mkdir(cwd, { recursive: true })
      await task.start(run.id)

      for await (const event of harness.run({
        conversationId,
        text: taskPrompt(run, cwd),
        cwd,
        signal: controller.signal,
        // 会话建好后把 harness 侧 id 记进账本（以后 resume 用）
        onSession: (sessionId) => {
          void task.start(run.id, { sessionId }).catch(() => undefined)
        },
      })) {
        if (event.type === 'text') collected += event.text
        else if (event.type === 'error') failure = event.message
        else if (event.type === 'usage') {
          await task.reportUsage(run.id, event.usage).catch(() => undefined)
        }
      }
    } catch (error) {
      failure = messageOf(error)
    } finally {
      clearTimeout(timer)
      const current = await task.get(run.id)
      // 子 agent 可能已经用 qm_finish_task 收尾；那样就不再覆盖
      if (current && current.finishedAt === null) {
        if (controller.signal.aborted) {
          await task.finish(run.id, { status: 'cancelled', error: `超过 ${timeoutMs}ms 未完成` })
        } else if (failure) {
          await task.finish(run.id, { status: 'failed', error: failure })
        } else {
          const result = collected.trim()
          await task.finish(run.id, { status: 'done', ...(result ? { result } : {}) })
        }
      }
      await harness.close(conversationId).catch(() => undefined)
    }
  }
}

export function apply(ctx: Context, config: TaskConfig = {}): void {
  const task = ctx.reflect.get('task', false) as TaskService | undefined
  if (!task) throw new Error('[qm-task] 缺少 task 服务')
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!gateway) throw new Error('[qm-task] 缺少 gateway 服务')
  /** harness 是可选依赖：开发环境可能没装 DSH，此时派发返回「没有可用的 harness」 */
  const harness = ctx.reflect.get('harness', false) as HarnessService | undefined

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const harnessId = config.harnessId ?? DEFAULT_HARNESS
  const runner = new TaskRunner(ctx, { task, timeoutMs })

  // 任务状态变化推给 SSE，Web 任务面板直接订阅
  for (const [event, type] of [
    [EVENTS.taskRunStarted, 'task-started'],
    [EVENTS.taskProgress, 'task-progress'],
    [EVENTS.taskFinished, 'task-finished'],
  ] as const) {
    ctx.events.on(event, (run: TaskRun) => {
      gateway.publish({ type, data: run })
    })
  }

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/tasks',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (!prompt) {
          res.status(400).send({ ok: false, error: 'prompt 不能为空' })
          return
        }

        const available = harness ? await harness.available().catch(() => false) : false
        if (!harness || !available) {
          res.status(503).send({ ok: false, error: '没有可用的 harness' })
          return
        }

        const run = await task.create({
          prompt,
          ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {}),
          ...(typeof body.project === 'string' && body.project.trim() ? { project: body.project.trim() } : {}),
          ...(typeof body.cwd === 'string' && body.cwd.trim() ? { cwd: body.cwd.trim() } : {}),
          harnessId,
        })
        res.status(202).send({ ok: true, run })
        // 派发是后台动作：HTTP 先返回 run，进度靠事件与轮询
        runner.dispatch(run)
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/tasks',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const id = (req.query.id ?? '').trim()
        if (id) {
          const run = await task.get(id)
          if (!run) {
            res.status(404).send({ ok: false, error: '没有这个任务' })
            return
          }
          res.status(200).send({ ok: true, run })
          return
        }
        const limit = Number(req.query.limit ?? LIST_LIMIT)
        res.status(200).send({ ok: true, items: await task.list(Number.isFinite(limit) ? limit : LIST_LIMIT) })
      },
    }),
  )
}

/** 把 runId 与上报方式写进 prompt：子 agent 只有知道 id 才能汇报 */
function taskPrompt(run: TaskRun, cwd: string): string {
  return [
    '你是青梅派出的执行子 agent。',
    `本次运行的 runId 是 ${run.id}，工作目录是 ${cwd}。`,
    '过程中请用 MCP 工具 qm_report_progress 上报进度（参数 runId、phase、note，percent 可选）；',
    '任务结束时调用 qm_finish_task（参数 runId、status、summary）收尾，再用一句话给出结论。',
    '',
    `任务：${run.prompt}`,
  ].join('\n')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const defaultExport = { name, inject, apply }
