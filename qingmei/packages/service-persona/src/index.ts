/**
 * @qingmei/service-persona —— 版本化人格包。
 *
 * 人格包是一个 JSON 文件：{ name, version, prompt }。
 * 服务启动时读取，`reload()` 可热加载；`hash` 供审计/对比版本用。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from 'cordis'
import { PersonaService, type PersonaSnapshot } from '@qingmei/core'

export interface Config {
  /** 人格包路径；默认 personas/qingmei.json（相对进程工作目录） */
  path?: string
  name?: string
  version?: string
  prompt?: string
}

export const name = 'service-persona'

interface PersonaFile {
  name?: unknown
  version?: unknown
  prompt?: unknown
}

export class Persona extends PersonaService {
  private readonly file: string
  private readonly fallback: { name: string; version: string; prompt: string }
  private snapshot: PersonaSnapshot

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.file = path.resolve(config.path ?? 'personas/qingmei.json')
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
  new Persona(ctx, config)
}

export default { name, apply }
