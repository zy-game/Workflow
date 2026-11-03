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
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
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

  history(skillName: string): { id: string; at: number }[] {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(skillName)) return []
    return this.backups(skillName).map((item) => ({ id: item.id, at: item.at }))
  }

  async rollback(skillName: string, id?: string): Promise<SkillDefinition> {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(skillName)) throw new Error('技能名不合法')
    const list = this.backups(skillName)
    const chosen = id ? list.find((item) => item.id === id) : list[0]
    if (!chosen) throw new Error(`没有可回滚的版本：${skillName}`)
    const folder = path.join(this.dir, skillName)
    const safety = path.join(this.dir, '.backup', `${skillName}-${Date.now()}`)
    await mkdir(path.dirname(safety), { recursive: true })
    if (existsSync(folder)) await rename(folder, safety)
    await cp(chosen.path, folder, { recursive: true })
    await this.load()
    const restored = this.definitions.find((definition) => definition.name === skillName)
    if (!restored) throw new Error('回滚后校验失败：技能没有被加载')
    return restored
  }

  private backups(skillName: string): { id: string; path: string; at: number }[] {
    const dir = path.join(this.dir, '.backup')
    if (!existsSync(dir)) return []
    const prefix = `${skillName}-`
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({
        id: name,
        path: path.join(dir, name),
        at: Number(name.slice(prefix.length)) || 0,
      }))
      .filter((item) => Number.isFinite(item.at) && item.at > 0)
      .sort((a, b) => b.at - a.at)
  }
  async install(input: {
    name: string
    body: string
    description?: string
    tools?: string[]
  }): Promise<SkillDefinition> {
    const skillName = String(input.name ?? '').trim()
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(skillName)) throw new Error('技能名只允许小写字母/数字/短横线（≤40）')
    const body = String(input.body ?? '')
    if (!body.trim()) throw new Error('SKILL.md 不能为空')
    const folder = path.join(this.dir, skillName)
    const recent = this.backups(skillName).filter((item) => item.at >= Date.now() - 30 * 24 * 60 * 60 * 1000)
    if (existsSync(folder) && recent.length >= 3) {
      throw new Error('同一技能 30 天内已被自动修改 3 次，先人工复核')
    }
    const backup = path.join(this.dir, '.backup', `${skillName}-${Date.now()}`)
    let hadExisting = false
    if (existsSync(folder)) {
      await mkdir(path.dirname(backup), { recursive: true })
      await rename(folder, backup)
      hadExisting = true
    }
    try {
      await mkdir(folder, { recursive: true })
      await writeFile(path.join(folder, 'SKILL.md'), body.slice(0, 200_000), 'utf8')
      await writeFile(
        path.join(folder, 'skill.json'),
        JSON.stringify(
          {
            name: skillName,
            description: String(input.description ?? '').slice(0, 300),
            tools: Array.isArray(input.tools) ? input.tools.map(String).slice(0, 20) : [],
          },
          null,
          2,
        ),
        'utf8',
      )
      await this.load()
      const installed = this.definitions.find((definition) => definition.name === skillName)
      if (!installed) throw new Error('安装后校验失败：技能没有被加载')
      return installed
    } catch (error) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined)
      if (hadExisting) {
        await mkdir(path.dirname(folder), { recursive: true })
        await cp(backup, folder, { recursive: true }).catch(() => undefined)
      }
      await this.load()
      throw error
    }
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
      path: '/api/v1/skills/install',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const skills = ctx.reflect.get('skills', false) as SkillService & {
          install?: (input: { name: string; body: string; description?: string; tools?: string[] }) => Promise<SkillDefinition>
        }
        if (!skills?.install) {
          res.status(501).send({ ok: false, error: '当前技能实现不支持安装' })
          return
        }
        try {
          const skill = await skills.install({
            name: String(body.name ?? ''),
            body: String(body.body ?? ''),
            description: typeof body.description === 'string' ? body.description : '',
            tools: Array.isArray(body.tools) ? body.tools.map(String) : [],
          })
          res.status(200).send({ ok: true, skill })
        } catch (error) {
          res.status(400).send({ ok: false, error: error instanceof Error ? error.message : '安装失败' })
        }
      },
    }),
  )
  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/skills/history',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''
        const skills = ctx.reflect.get('skills', false) as SkillService & {
          history?: (name: string) => { id: string; at: number }[]
        }
        if (!name) {
          res.status(400).send({ ok: false, error: 'name 必填' })
          return
        }
        res.status(200).send({ ok: true, items: skills.history?.(name) ?? [] })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/skills/rollback',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        const id = typeof body.id === 'string' ? body.id.trim() : undefined
        const skills = ctx.reflect.get('skills', false) as SkillService & {
          rollback?: (name: string, id?: string) => Promise<SkillDefinition>
        }
        if (!name || !skills.rollback) {
          res.status(400).send({ ok: false, error: 'name 必填或当前实现不支持回滚' })
          return
        }
        try {
          res.status(200).send({ ok: true, skill: await skills.rollback(name, id) })
        } catch (error) {
          res.status(404).send({ ok: false, error: error instanceof Error ? error.message : '回滚失败' })
        }
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
