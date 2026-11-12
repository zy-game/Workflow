/**
 * @qingmei/qm-evolve —— 自我进化的写入口：把「做成过的事」变成技能草稿。
 *
 * 只提案、不自动安装：成功任务收尾 → 生成草稿 → 人在「技能」页采纳才 install。
 * 技能本身已有版本备份与 rollback（qm-skill），所以进化是可撤销的。
 *
 * 不碰代码、不碰权限：草稿内容只有 prompt/结果/产物，安装只写 skills/<name>/。
 */
import type { Context } from 'cordis'
import {
  EVENTS,
  uid,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type Row,
  type StoreService,
  type TaskRun,
} from '@qingmei/core'

export const name = 'qm-evolve'
export const inject = ['store', 'gateway']

export interface EvolveConfig {
  /** 待采纳草稿上限，超过就不再生成 */
  maxDrafts?: number
  /** 结果至少多长才值得沉淀 */
  minResultChars?: number
}

interface DraftRow extends Row {
  task_id: string
  name: string
  description: string
  body: string
  status: 'proposed' | 'installed' | 'rejected'
  created_at: number
  decided_at: number | null
  skill_name: string | null
}

/** qm-skill 的写接口不在 SkillService 抽象里，这里用结构化类型接住 */
type Installer = { install(input: { name: string; body: string; description?: string }): Promise<{ name: string }> }

function skillNameOf(taskId: string): string {
  return `task-${taskId.replace(/^run_/, '').slice(-12).toLowerCase()}`
}

function draftBody(run: TaskRun): string {
  const lines = [
    `# ${run.title}`,
    '',
    '## 什么时候用',
    `和「${run.title}」类似的任务。`,
    '',
    '## 步骤',
    '1. 先确认前置条件与输入。',
    `2. 执行：${String(run.prompt ?? '').slice(0, 800)}`,
    '3. 校验产物，失败就停下来说明原因。',
    '',
    '## 结果',
    String(run.result ?? '').slice(0, 2000),
  ]
  if (run.artifacts.length > 0) {
    lines.push('', '## 产物')
    for (const artifact of run.artifacts.slice(0, 10)) {
      lines.push(`- ${artifact.name}${artifact.url ? `：${artifact.url}` : ''}`)
    }
  }
  return lines.join('\n')
}

export function apply(ctx: Context, config: EvolveConfig = {}): void {
  const store = ctx.store as StoreService
  const gateway = ctx.gateway as GatewayService
  const drafts = store.collection<DraftRow>('qm_skill_draft')
  const maxDrafts = Math.max(1, config.maxDrafts ?? 20)
  const minResultChars = Math.max(1, config.minResultChars ?? 20)

  ctx.events.on(EVENTS.taskFinished, (run: TaskRun) => {
    if (run.kind !== 'task') return
    if (run.status !== 'done') return
    const result = String(run.result ?? '').trim()
    if (result.length < minResultChars) return
    void (async () => {
      const existing = await drafts.find({ where: { task_id: run.id } })
      if (existing.length > 0) return
      const pending = await drafts.count({ where: { status: 'proposed' } })
      if (pending >= maxDrafts) {
        ctx.logger?.warn?.(`[qm-evolve] 草稿已满（${maxDrafts}），跳过 ${run.id}`)
        return
      }
      await drafts.insert({
        id: uid('draft'),
        task_id: run.id,
        name: skillNameOf(run.id),
        description: String(run.title ?? '').slice(0, 80),
        body: draftBody(run),
        status: 'proposed',
        created_at: Date.now(),
        decided_at: null,
        skill_name: null,
      })
    })().catch((error) => {
      ctx.logger?.warn?.(`[qm-evolve] 生成技能草稿失败：${error instanceof Error ? error.message : String(error)}`)
    })
  })

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/skills/drafts',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const status = String(req.query.status ?? 'proposed').trim() as DraftRow['status'] | 'all'
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
        const rows =
          status === 'all'
            ? await drafts.find({ order: [{ field: 'created_at', dir: 'desc' }], limit })
            : await drafts.find({ where: { status }, order: [{ field: 'created_at', dir: 'desc' }], limit })
        res.status(200).send({ ok: true, items: rows })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/skills/drafts/install',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const row = await drafts.get(id)
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这条草稿' })
          return
        }
        if (row.status !== 'proposed') {
          res.status(409).send({ ok: false, error: `草稿已是 ${row.status}` })
          return
        }
        const skills = ctx.get('skills', false) as unknown as Installer | undefined
        if (!skills?.install) {
          res.status(409).send({ ok: false, error: '技能服务未启用' })
          return
        }
        const installed = await skills.install({ name: row.name, body: row.body, description: row.description })
        await drafts.update(id, { status: 'installed', decided_at: Date.now(), skill_name: installed.name })
        res.status(200).send({ ok: true, item: await drafts.get(id), skill: installed.name })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/skills/drafts/reject',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        const row = await drafts.get(id)
        if (!row) {
          res.status(404).send({ ok: false, error: '没有这条草稿' })
          return
        }
        await drafts.update(id, { status: 'rejected', decided_at: Date.now() })
        res.status(200).send({ ok: true, item: await drafts.get(id) })
      },
    }),
  )
}

export const defaultExport = { name, inject, apply }

