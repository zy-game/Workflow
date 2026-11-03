/**
 * @qingmei/qm-skill —— M6 技能包最小版。
 *
 * 一个技能就是一个目录：
 *   skills/<name>/SKILL.md    正文（模型读的指令）
 *   skills/<name>/skill.json  {"description": "...", "tools": ["qm_finish_task"]}
 *
 * 不改代码：放进目录 → `POST /api/v1/skills/reload` 或重启即生效。
 * 工具白名单随定义返回，由执行器/宿主决定是否裁剪。
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Context } from 'cordis'
import {
  SkillService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type SkillDefinition,
} from '@qingmei/core'

export interface SkillConfig {
  skillsDir?: string
}

export const name = 'qm-skill'
export const inject = ['gateway']

class FileSkills extends SkillService {
  private readonly dir: string
  private ready: Promise<void> = Promise.resolve()
  private definitions: (SkillDefinition & { body: string })[] = []

  constructor(ctx: Context, config: SkillConfig = {}) {
    super(ctx)
    this.dir = config.skillsDir ?? path.join(process.cwd(), 'skills')
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    const definitions: (SkillDefinition & { body: string })[] = []
    if (!existsSync(this.dir)) {
      this.definitions = definitions
      return
    }
    const entries = await readdir(this.dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const folder = path.join(this.dir, entry.name)
      const manifestPath = path.join(folder, 'skill.json')
      const bodyPath = path.join(folder, 'SKILL.md')
      if (!existsSync(manifestPath) || !existsSync(bodyPath)) continue
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          name?: string
          description?: string
          tools?: string[]
        }
        const skillName = (manifest.name ?? entry.name).trim()
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(skillName)) continue
        const body = (await readFile(bodyPath, 'utf8')).slice(0, 200_000)
        definitions.push({
          name: skillName,
          description: String(manifest.description ?? '').slice(0, 300),
          tools: Array.isArray(manifest.tools) ? manifest.tools.map(String).slice(0, 20) : [],
          dir: path.resolve(folder),
          body,
        })
      } catch {
        // 单个坏技能不影响其它
      }
    }
    definitions.sort((a, b) => a.name.localeCompare(b.name))
    this.definitions = definitions
  }

  async list(): Promise<SkillDefinition[]> {
    await this.ready
    return this.definitions.map(({ body: _body, ...definition }) => definition)
  }

  async read(skillName: string): Promise<(SkillDefinition & { body: string }) | null> {
    await this.ready
    return this.definitions.find((definition) => definition.name === skillName) ?? null
  }

  async reload(): Promise<SkillDefinition[]> {
    await this.load()
    return this.list()
  }
}

export function apply(ctx: Context, config: SkillConfig = {}): void {
  ctx.plugin(FileSkills, config)
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!gateway) return

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/skills',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const skills = ctx.reflect.get('skills', false) as SkillService
        res.status(200).send({ ok: true, items: await skills.list() })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/skills/read',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''
        if (!name) {
          res.status(400).send({ ok: false, error: 'name 必填' })
          return
        }
        const skills = ctx.reflect.get('skills', false) as SkillService
        const skill = await skills.read(name)
        res.status(skill ? 200 : 404).send(skill ? { ok: true, skill } : { ok: false, error: '没有这个技能' })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/skills/reload',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        const skills = ctx.reflect.get('skills', false) as SkillService
        res.status(200).send({ ok: true, items: await skills.reload() })
      },
    }),
  )
}

export const defaultExport = { name, inject, apply }
