/**
 * @qingmei/service-persona —— 版本化人格包。
 *
 * 人格包是一个 JSON 文件：{ name, version, prompt }。
 * 服务启动时读取，`reload()` 可热加载；`hash` 供审计/对比版本用。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from 'cordis'
import {
  PersonaService,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayService,
  type PersonaSnapshot,
} from '@qingmei/core'

export interface Config {
  /** 人格包路径；默认 personas/qingmei.json（相对进程工作目录） */
  path?: string
  name?: string
  version?: string
  prompt?: string
  /** 快照目录；默认人格文件旁的 history/ */
  historyDir?: string
}

export const name = 'service-persona'

interface HistoryEntry {
  id: string
  hash: string
  version: string
  prompt: string
  note: string
  kind: 'apply' | 'rollback' | 'snapshot'
  createdAt: string
}

export class PersonaFuseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersonaFuseError'
  }
}

interface PersonaFile {
  name?: unknown
  version?: unknown
  prompt?: unknown
}

export class Persona extends PersonaService {
  private readonly file: string
  private readonly fallback: { name: string; version: string; prompt: string }
  private readonly historyDir: string
  private snapshot: PersonaSnapshot

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.file = path.resolve(config.path ?? 'personas/qingmei.json')
    this.historyDir = path.resolve(config.historyDir ?? path.join(path.dirname(this.file), 'history'))
    this.fallback = {
      name: typeof config.name === 'string' && config.name.trim() ? config.name.trim() : '青梅',
      version: typeof config.version === 'string' && config.version.trim() ? config.version.trim() : '0.0.0',
      prompt:
        typeof config.prompt === 'string' && config.prompt.trim()
          ? config.prompt.trim()
          : '你叫青梅，是一个务实的个人助理。回答简短。',
    }
    this.snapshot = this.load()
  }

  current(): PersonaSnapshot {
    return this.snapshot
  }

  async reload(): Promise<PersonaSnapshot> {
    this.snapshot = this.load()
    return this.snapshot
  }

  async apply(input: { prompt: string; version?: string; note?: string }): Promise<PersonaSnapshot> {
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) throw new Error('prompt 不能为空')
    if (prompt.length > 4000) throw new Error('prompt 不能超过 4000 字')
    this.assertFuse()
    this.snapshotCurrent('snapshot', 'apply 前自动快照')
    const version = String(input.version ?? this.bumpVersion()).trim()
    writeFileSync(
      this.file,
      JSON.stringify({ name: this.snapshot.name, version, prompt }, null, 2),
      'utf8',
    )
    this.snapshot = this.load()
    this.recordHistory('apply', String(input.note ?? '').slice(0, 200))
    return this.snapshot
  }

  history(): HistoryEntry[] {
    return this.listHistory()
  }

  async rollback(id: string): Promise<PersonaSnapshot> {
    const entry = this.listHistory().find((item) => item.id === id)
    if (!entry) throw new Error(`没有这个快照：${id}`)
    this.snapshotCurrent('snapshot', 'rollback 前自动快照')
    writeFileSync(
      this.file,
      JSON.stringify({ name: this.snapshot.name, version: entry.version, prompt: entry.prompt }, null, 2),
      'utf8',
    )
    this.snapshot = this.load()
    this.recordHistory('rollback', `回滚到 ${id}`)
    return this.snapshot
  }

  private assertFuse(): void {
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000
    const changes = this.listHistory().filter(
      (item) => item.kind === 'apply' && Date.parse(item.createdAt) >= since,
    )
    if (changes.length >= 3) {
      throw new PersonaFuseError('同一人格文件 30 天内已被自动修改 3 次，先人工复核')
    }
  }

  private snapshotCurrent(kind: HistoryEntry['kind'], note: string): void {
    if (!existsSync(this.file)) return
    const current = this.snapshot
    this.writeHistory(kind, note, current.version, current.prompt)
  }

  private recordHistory(kind: HistoryEntry['kind'], note: string): void {
    this.writeHistory(kind, note, this.snapshot.version, this.snapshot.prompt)
  }

  private writeHistory(kind: HistoryEntry['kind'], note: string, version: string, prompt: string): void {
    mkdirSync(this.historyDir, { recursive: true })
    const createdAt = new Date().toISOString()
    const hash = createHash('sha256').update(`${version}\n${prompt}`).digest('hex').slice(0, 12)
    const id = `${Date.now()}-${hash}`
    const entry: HistoryEntry = { id, hash, version, prompt, note, kind, createdAt }
    writeFileSync(path.join(this.historyDir, `${id}.json`), JSON.stringify(entry, null, 2), 'utf8')
  }

  private listHistory(): HistoryEntry[] {
    if (!existsSync(this.historyDir)) return []
    const entries: HistoryEntry[] = []
    for (const name of readdirSync(this.historyDir)) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(path.join(this.historyDir, name), 'utf8')) as HistoryEntry
        if (parsed && typeof parsed.prompt === 'string' && typeof parsed.id === 'string') entries.push(parsed)
      } catch {
        // 坏快照跳过
      }
    }
    return entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 100)
  }

  private bumpVersion(): string {
    const parts = this.snapshot.version.split('.')
    const patch = Number(parts[2] ?? 0)
    return `${parts[0] ?? '1'}.${parts[1] ?? '0'}.${Number.isFinite(patch) ? patch + 1 : 1}`
  }
  private load(): PersonaSnapshot {
    let file: PersonaFile = {}
    if (existsSync(this.file)) {
      try {
        file = JSON.parse(readFileSync(this.file, 'utf8')) as PersonaFile
      } catch (error) {
        this.ctx.logger?.warn(`人格包解析失败，使用内置人格：${String(error)}`)
        file = {}
      }
    }
    const name = typeof file.name === 'string' && file.name.trim() ? file.name.trim() : this.fallback.name
    const version =
      typeof file.version === 'string' && file.version.trim() ? file.version.trim() : this.fallback.version
    const prompt =
      typeof file.prompt === 'string' && file.prompt.trim() ? file.prompt.trim() : this.fallback.prompt
    return {
      name,
      version,
      prompt,
      hash: createHash('sha256').update(`${version}\n${prompt}`).digest('hex').slice(0, 12),
      updatedAt: new Date(),
    }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const persona = new Persona(ctx, config)
  const gateway = ctx.reflect.get('gateway', false) as GatewayService | undefined
  if (!gateway) return

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/persona/history',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        res.status(200).send({ ok: true, current: persona.current(), items: persona.history() })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/persona/apply',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        try {
          const snapshot = await persona.apply({
            prompt: String(body.prompt ?? ''),
            ...(typeof body.version === 'string' ? { version: body.version } : {}),
            ...(typeof body.note === 'string' ? { note: body.note } : {}),
          })
          res.status(200).send({ ok: true, persona: snapshot })
        } catch (error) {
          const status = error instanceof PersonaFuseError ? 409 : 400
          res.status(status).send({ ok: false, error: error instanceof Error ? error.message : '应用失败' })
        }
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/persona/rollback',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          res.status(400).send({ ok: false, error: 'id 必填' })
          return
        }
        try {
          res.status(200).send({ ok: true, persona: await persona.rollback(id) })
        } catch (error) {
          res.status(404).send({ ok: false, error: error instanceof Error ? error.message : '回滚失败' })
        }
      },
    }),
  )
}

export default { name, apply }
