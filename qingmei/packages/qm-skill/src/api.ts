/**
 * qm-skill 的 HTTP 面。
 *
 * 提供技能服务的插件只负责 FileSkills；本插件负责把技能服务暴露成 API。
 * 这样 qm-skill 不需要 inject 自己提供的服务。
 */
import type { Context } from 'cordis'
import type { GatewayRequest, GatewayResponse, SkillDefinition, SkillService } from '@qingmei/core'

export function registerSkillApi(ctx: Context, skills: SkillService): void {
  const gateway = ctx.gateway

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/skills',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
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
        const skillApi = skills as typeof skills & {
          install?: (input: {
            name: string
            body: string
            description?: string
            tools?: string[]
          }) => Promise<SkillDefinition>
        }
        if (!skillApi.install) {
          res.status(501).send({ ok: false, error: '当前技能实现不支持安装' })
          return
        }
        try {
          const skill = await skillApi.install({
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
        const skillName = typeof req.query.name === 'string' ? req.query.name.trim() : ''
        const skillApi = skills as typeof skills & {
          history?: (name: string) => { id: string; at: number }[]
        }
        if (!skillName) {
          res.status(400).send({ ok: false, error: 'name 必填' })
          return
        }
        res.status(200).send({ ok: true, items: skillApi.history?.(skillName) ?? [] })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/skills/rollback',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const skillName = typeof body.name === 'string' ? body.name.trim() : ''
        const id = typeof body.id === 'string' ? body.id.trim() : undefined
        const skillApi = skills as typeof skills & {
          rollback?: (name: string, id?: string) => Promise<SkillDefinition>
        }
        if (!skillName || !skillApi.rollback) {
          res.status(400).send({ ok: false, error: 'name 必填或当前实现不支持回滚' })
          return
        }
        try {
          res.status(200).send({ ok: true, skill: await skillApi.rollback(skillName, id) })
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
        res.status(200).send({ ok: true, items: await skills.reload() })
      },
    }),
  )
}

