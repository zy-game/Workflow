/**
 * 画像：青梅自己、主人、群，各一份。
 *
 * - self：人格与说话风格，覆盖 qm-agent 的静态 persona；
 * - person：主人画像（偏好/习惯/边界）；
 * - group：群规则（禁提项目、脱敏、要不要审批）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import { uid, type Collection, type GatewayRequest, type GatewayResponse, type Row } from '@qingmei/core'

export const name = 'qm-portrait'
export const inject = ['store', 'gateway']

export type PortraitKind = 'self' | 'person' | 'group'

export interface PortraitRules {
  /** 群里禁止出现的词/项目名 */
  blocked?: string[]
  /** 命中后是否必须走审批 */
  requireApproval?: boolean
  /** 给模型看的群规则说明 */
  note?: string
}

export interface Portrait {
  id: string
  kind: PortraitKind
  name: string
  persona: string
  traits: string[]
  rules: PortraitRules
  sensitivity: 'public' | 'private' | 'secret'
  updatedAt: Date
}

interface PortraitRow extends Row {
  kind: string
  name: string
  persona: string
  traits_json: string
  rules_json: string
  sensitivity: string
  updated_at: number
}

export interface PortraitConfig {
  /** self 画像没有时用的兜底人格 */
  persona?: string
  /** 人格文件：优先于 persona 字符串，便于随仓库版本化 */
  personaFile?: string
}

class PortraitService extends Service {
  private readonly collection: Collection<PortraitRow>
  private readonly fallbackPersona: string
  private readonly personaFile: string

  constructor(ctx: Context, collection: Collection<PortraitRow>, config: PortraitConfig) {
    super(ctx, 'portrait')
    this.collection = collection
    this.personaFile = config.personaFile ? path.resolve(config.personaFile) : ''
    this.fallbackPersona = this.readPersonaFile() || (config.persona ?? '')
  }

  private readPersonaFile(): string {
    if (!this.personaFile) return ''
    try {
      return readFileSync(this.personaFile, 'utf8').trim()
    } catch {
      return ''
    }
  }

  async ensureDefaults(): Promise<void> {
    const existing = await this.collection.get('self')
    if (!existing && this.fallbackPersona.trim()) {
      await this.collection.insert({
        id: 'self',
        kind: 'self',
        name: '青梅',
        persona: this.fallbackPersona.trim(),
        traits_json: '[]',
        rules_json: '{}',
        sensitivity: 'private',
        updated_at: Date.now(),
      })
    }
  }

  async list(kind?: PortraitKind): Promise<Portrait[]> {
    const rows = (await this.collection.find({})) as PortraitRow[]
    return rows
      .filter((row) => (kind ? row.kind === kind : true))
      .sort((a, b) => b.updated_at - a.updated_at)
      .map(toPortrait)
  }

  async self(): Promise<Portrait | null> {
    const row = await this.collection.get('self')
    return row ? toPortrait(row) : null
  }

  async person(): Promise<Portrait | null> {
    const row = await this.collection.get('owner')
    return row ? toPortrait(row) : null
  }

  async group(conversationId: string): Promise<Portrait | null> {
    const row = await this.collection.get(`group:${conversationId}`)
    return row ? toPortrait(row) : null
  }

  async upsert(input: {
    id?: string
    kind: PortraitKind
    name?: string
    persona?: string
    traits?: string[]
    rules?: PortraitRules
    sensitivity?: Portrait['sensitivity']
  }): Promise<Portrait> {
    const id = input.id?.trim() || (input.kind === 'self' ? 'self' : input.kind === 'person' ? 'owner' : uid('group'))
    const existing = (await this.collection.get(id)) as PortraitRow | null
    const row: Omit<PortraitRow, 'id'> = {
      kind: input.kind,
      name: (input.name ?? existing?.name ?? (input.kind === 'self' ? '青梅' : id)).slice(0, 80),
      persona: (input.persona ?? existing?.persona ?? '').slice(0, 4000),
      traits_json: JSON.stringify(input.traits ?? parseArray(existing?.traits_json)),
      rules_json: JSON.stringify(input.rules ?? parseObject(existing?.rules_json)),
      sensitivity: input.sensitivity ?? ((existing?.sensitivity as Portrait['sensitivity']) ?? 'private'),
      updated_at: Date.now(),
    }
    if (existing) await this.collection.update(id, row)
    else await this.collection.insert({ id, ...row })
    return toPortrait({ id, ...row } as PortraitRow)
  }
}

function parseArray(raw: string | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseObject(raw: string | undefined): PortraitRules {
  try {
    const parsed = JSON.parse(raw ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as PortraitRules) : {}
  } catch {
    return {}
  }
}

function toPortrait(row: PortraitRow): Portrait {
  return {
    id: row.id,
    kind: (row.kind as PortraitKind) ?? 'person',
    name: row.name,
    persona: row.persona,
    traits: parseArray(row.traits_json),
    rules: parseObject(row.rules_json),
    sensitivity: (row.sensitivity as Portrait['sensitivity']) ?? 'private',
    updatedAt: new Date(row.updated_at),
  }
}

export function apply(ctx: Context, config: PortraitConfig = {}): void {
  const store = ctx.store
  const gateway = ctx.gateway
  const service = new PortraitService(ctx, store.collection<PortraitRow>('qm_portrait'), config)
  void service.ensureDefaults()

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/portraits',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const kind = String(req.query.kind ?? '').trim()
        const items = await service.list(
          kind === 'self' || kind === 'person' || kind === 'group' ? (kind as PortraitKind) : undefined,
        )
        res.status(200).send({ ok: true, items })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/portraits',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const kind = String(body.kind ?? '').trim()
        if (kind !== 'self' && kind !== 'person' && kind !== 'group') {
          res.status(400).send({ ok: false, error: 'kind 必须是 self/person/group' })
          return
        }
        const portrait = await service.upsert({
          ...(typeof body.id === 'string' ? { id: body.id } : {}),
          kind,
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.persona === 'string' ? { persona: body.persona } : {}),
          ...(Array.isArray(body.traits)
            ? { traits: body.traits.filter((item): item is string => typeof item === 'string') }
            : {}),
          ...(body.rules && typeof body.rules === 'object' ? { rules: body.rules as PortraitRules } : {}),
          ...(body.sensitivity === 'public' || body.sensitivity === 'private' || body.sensitivity === 'secret'
            ? { sensitivity: body.sensitivity }
            : {}),
        })
        res.status(200).send({ ok: true, portrait })
      },
    }),
  )
}

