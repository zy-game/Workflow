/**
 * @qingmei/qm-identity —— 渠道账号 ↔ Actor 绑定（docs/02 identity、docs/10 N+）。
 *
 * 单用户部署的默认策略：每个渠道还没有 owner 绑定时，第一个私聊用户自动绑成 owner；
 * 之后的陌生账号需要显式 `POST /api/v1/identity/bind`，否则 agent 回「未授权」。
 * 绑定是全局的：同一 owner 在飞书/QQ/Web 的账号指向同一个 Actor。
 */
import type { Context } from 'cordis'
import {
  IdentityService,
  uid,
  type Actor,
  type ChannelId,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type IdentityBinding,
  type Row,
  type StoreService,
} from '@qingmei/core'

export interface IdentityConfig {
  /** 每渠道第一个私聊自动绑 owner；默认开（单用户部署） */
  autoBindOwner?: boolean
}

export const name = 'qm-identity'
export const inject = ['store', 'gateway']

const ACTOR_COLLECTION = 'qm_identity_actor'
const BINDING_COLLECTION = 'qm_identity_binding'
const ROLES: Actor['role'][] = ['owner', 'family', 'guest', 'stranger']

interface ActorRow extends Row {
  display_name: string
  role: string
}

interface VerifyRow extends Row {
  code: string
  channel: string
  platform_user_id: string
  display_name: string
  status: string
  expires_at: number
  created_at: number
}

interface BindingRow extends Row {
  channel: string
  platform_user_id: string
  actor_id: string
  display_name: string
  created_at: number
}

export class SqliteIdentity extends IdentityService {
  private readonly actors
  private readonly bindings
  private readonly autoBindOwner: boolean
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: IdentityConfig = {}) {
    super(ctx)
    const store = ctx.reflect.get('store', false) as StoreService | undefined
    if (!store) throw new Error('[qm-identity] 缺少 store 服务')
    this.actors = store.collection<ActorRow>(ACTOR_COLLECTION)
    this.bindings = store.collection<BindingRow>(BINDING_COLLECTION)
    this.autoBindOwner = config.autoBindOwner !== false
    void this.ensureOwnerActor().catch(() => undefined)
  }

  async resolve(channel: ChannelId, platformUserId: string): Promise<Actor | null> {
    const binding = await this.bindings.get(bindingKey(channel, platformUserId))
    if (!binding) return null
    return this.actor(binding.actor_id)
  }

  async bind(
    actorId: string,
    channel: ChannelId,
    platformUserId: string,
    options: { displayName?: string; role?: Actor['role'] } = {},
  ): Promise<Actor> {
    return this.serialize(() => this.bindInner(actorId, channel, platformUserId, options))
  }

  private async bindInner(
    actorId: string,
    channel: ChannelId,
    platformUserId: string,
    options: { displayName?: string; role?: Actor['role'] } = {},
  ): Promise<Actor> {
    return (async () => {
      const displayName = options.displayName?.trim() || actorId
      const role = options.role && ROLES.includes(options.role) ? options.role : actorId === 'owner' ? 'owner' : 'guest'
      const actor = (await this.actors.get(actorId)) ?? null
      if (actor) {
        await this.actors.update(actorId, { display_name: displayName, role })
      } else {
        await this.actors.insert({ id: actorId, display_name: displayName, role })
      }

      const id = bindingKey(channel, platformUserId)
      const existing = await this.bindings.get(id)
      const row = {
        channel,
        platform_user_id: platformUserId,
        actor_id: actorId,
        display_name: displayName,
        created_at: existing?.created_at ?? Date.now(),
      }
      if (existing) await this.bindings.update(id, row)
      else await this.bindings.insert({ id, ...row })
      return { id: actorId, displayName, role }
    })()
  }

  async unbind(actorId: string, channel: ChannelId): Promise<number> {
    return this.serialize(async () => {
      const rows = await this.bindings.find({})
      let removed = 0
      for (const row of rows) {
        if (row.actor_id !== actorId || row.channel !== channel) continue
        if (await this.bindings.delete(row.id)) removed += 1
      }
      return removed
    })
  }

  async actor(id: string): Promise<Actor | null> {
    const row = await this.actors.get(id)
    if (!row) return null
    return {
      id: row.id,
      displayName: row.display_name,
      role: ROLES.includes(row.role as Actor['role']) ? (row.role as Actor['role']) : 'guest',
    }
  }

  async list(): Promise<IdentityBinding[]> {
    const rows = await this.bindings.find({})
    return rows
      .map((row) => ({
        channel: row.channel as ChannelId,
        platformUserId: row.platform_user_id,
        actorId: row.actor_id,
        displayName: row.display_name,
        createdAt: new Date(row.created_at),
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }

  async ensureOwner(channel: ChannelId, platformUserId: string, displayName?: string): Promise<Actor | null> {
    if (!this.autoBindOwner) return null
    return this.serialize(async () => {
      const existing = await this.bindings.get(bindingKey(channel, platformUserId))
      if (existing) return this.actor(existing.actor_id)
      const rows = await this.bindings.find({})
      if (rows.some((row) => row.channel === channel && row.actor_id === 'owner')) return null
      return this.bindInner('owner', channel, platformUserId, {
        displayName: displayName?.trim() || '主人',
        role: 'owner',
      })
    })
  }

  private async ensureOwnerActor(): Promise<void> {
    if (await this.actors.get('owner')) return
    await this.actors.insert({ id: 'owner', display_name: '主人', role: 'owner' })
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

export function apply(ctx: Context, config: IdentityConfig = {}): void {
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!gateway) throw new Error('[qm-identity] 缺少 gateway 服务')
  const identity = new SqliteIdentity(ctx, config)

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/identity',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        res.status(200).send({
          ok: true,
          owner: await identity.actor('owner'),
          bindings: await identity.list(),
        })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/identity/bind',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const actorId = typeof body.actorId === 'string' ? body.actorId.trim() : ''
        const channel = typeof body.channel === 'string' ? body.channel.trim() : ''
        const platformUserId =
          typeof body.platformUserId === 'string' ? body.platformUserId.trim() : ''
        if (!actorId || !channel || !platformUserId) {
          res.status(400).send({ ok: false, error: 'actorId、channel、platformUserId 必填' })
          return
        }
        const role = ROLES.includes(body.role as Actor['role']) ? (body.role as Actor['role']) : undefined
        const actor = await identity.bind(actorId, channel as ChannelId, platformUserId, {
          ...(typeof body.displayName === 'string' && body.displayName.trim()
            ? { displayName: body.displayName.trim() }
            : {}),
          ...(role ? { role } : {}),
        })
        res.status(200).send({ ok: true, actor })
      },
    }),
  )

  const store = ctx.reflect.get('store', false) as StoreService | undefined
  const verifies = store?.collection<VerifyRow>('qm_identity_verify')

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/identity/verify/start',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const channel = typeof body.channel === 'string' ? body.channel.trim() : ''
        const platformUserId =
          typeof body.platformUserId === 'string' ? body.platformUserId.trim() : ''
        if (!channel || !platformUserId || !verifies) {
          res.status(400).send({ ok: false, error: 'channel、platformUserId 必填' })
          return
        }
        const code = uid('bind').slice(-8).toUpperCase()
        const expiresAt = Date.now() + 10 * 60 * 1000
        await verifies.insert({
          id: uid('verify'),
          code,
          channel,
          platform_user_id: platformUserId,
          display_name: typeof body.displayName === 'string' ? body.displayName.trim() : '',
          status: 'pending',
          expires_at: expiresAt,
          created_at: Date.now(),
        })
        res.status(200).send({ ok: true, code, expiresAt: new Date(expiresAt).toISOString() })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/identity/verify/confirm',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : ''
        const channel = typeof body.channel === 'string' ? body.channel.trim() : ''
        const platformUserId =
          typeof body.platformUserId === 'string' ? body.platformUserId.trim() : ''
        if (!code || !channel || !platformUserId || !verifies) {
          res.status(400).send({ ok: false, error: 'code、channel、platformUserId 必填' })
          return
        }
        const pending = (await verifies.find({}))
          .filter(
            (row) =>
              row.code === code &&
              row.status === 'pending' &&
              row.expires_at > Date.now(),
          )
          .sort((a, b) => b.created_at - a.created_at)[0]
        if (!pending) {
          res.status(404).send({ ok: false, error: '验证码不存在或已过期' })
          return
        }
        const first = await identity.bind('owner', pending.channel as ChannelId, pending.platform_user_id, {
          ...(pending.display_name ? { displayName: pending.display_name } : {}),
          role: 'owner',
        })
        if (pending.channel !== channel || pending.platform_user_id !== platformUserId) {
          await identity.bind('owner', channel as ChannelId, platformUserId, { role: 'owner' })
        }
        await verifies.update(pending.id, { status: 'used' })
        res.status(200).send({ ok: true, actor: first })
      },
    }),
  )
  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/identity/unbind',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const actorId = typeof body.actorId === 'string' ? body.actorId.trim() : ''
        const channel = typeof body.channel === 'string' ? body.channel.trim() : ''
        if (!actorId || !channel) {
          res.status(400).send({ ok: false, error: 'actorId 和 channel 必填' })
          return
        }
        const removed = await identity.unbind(actorId, channel as ChannelId)
        res.status(200).send({ ok: true, removed })
      },
    }),
  )
}

function bindingKey(channel: string, platformUserId: string): string {
  return `${channel}:${platformUserId}`
}

export const defaultExport = { name, inject, apply }
