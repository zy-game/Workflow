/**
 * 运行设置：把原先只在 /etc/qingmei/env 里的 key 搬进设置页。
 *
 * 密钥加密后落库；保存时同时写回 process.env（当前进程立即生效的插件会用到），
 * 但多数 provider 在构造时读 env，所以仍提示重启。
 */
import { Service, type Context } from 'cordis'
import {
  decryptSecret,
  encryptSecret,
  type Collection,
  type GatewayRequest,
  type GatewayResponse,
  type Row,
} from '@qingmei/core'

export const name = 'qm-settings'
export const inject = ['store', 'gateway']

export interface SettingSpec {
  key: string
  label: string
  secret: boolean
  hint?: string
}

export const SETTING_KEYS: SettingSpec[] = [
  { key: 'QM_LLM_BASE_URL', label: '模型 Base URL', secret: false, hint: '例如 https://api.deepseek.com' },
  { key: 'QM_LLM_KEY', label: '模型 API Key', secret: true },
  { key: 'QM_DSH_API_KEY', label: 'DSH API Key', secret: true },
  { key: 'QM_MCP_TOKEN', label: 'MCP Token', secret: true },
  { key: 'QM_EMBEDDING_URL', label: 'Embedding URL', secret: false },
  { key: 'QM_EMBEDDING_KEY', label: 'Embedding Key', secret: true },
  { key: 'QM_EMBEDDING_MODEL', label: 'Embedding 模型', secret: false },
  { key: 'QM_FEISHU_APP_ID', label: '飞书 App ID', secret: false },
  { key: 'QM_FEISHU_APP_SECRET', label: '飞书 App Secret', secret: true },
  { key: 'QM_QQ_APP_ID', label: 'QQ App ID', secret: false },
  { key: 'QM_QQ_CLIENT_SECRET', label: 'QQ Client Secret', secret: true },
]

export const SETTING_KEY_SET = new Set(SETTING_KEYS.map((item) => item.key))

interface SettingRow extends Row {
  id: string
  value: string
  secret: boolean
  updated_at: number
}

function mask(value: string): string {
  if (!value) return ''
  if (value.length <= 4) return '••••'
  return `${'•'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`
}

class SettingsService extends Service {
  private readonly rows: Collection<SettingRow>
  private readonly envDefaults: Record<string, string | undefined>

  constructor(ctx: Context, rows: Collection<SettingRow>) {
    super(ctx, 'settings')
    this.rows = rows
    this.envDefaults = Object.fromEntries(SETTING_KEYS.map((item) => [item.key, process.env[item.key]]))
  }

  private async rowOf(key: string): Promise<SettingRow | null> {
    return (await this.rows.get(key).catch(() => null)) as SettingRow | null
  }

  async list(): Promise<
    Array<SettingSpec & { configured: boolean; source: 'settings' | 'env' | 'unset'; value: string; masked: string }>
  > {
    const out: Array<
      SettingSpec & { configured: boolean; source: 'settings' | 'env' | 'unset'; value: string; masked: string }
    > = []
    for (const spec of SETTING_KEYS) {
      const row = await this.rowOf(spec.key)
      const envValue = this.envDefaults[spec.key] ?? ''
      const raw = row ? (row.secret ? decryptSecret(row.value) ?? '' : row.value) : envValue
      const configured = Boolean(row || envValue)
      out.push({
        ...spec,
        configured,
        source: (row ? 'settings' : envValue ? 'env' : 'unset') as 'settings' | 'env' | 'unset',
        value: spec.secret ? '' : raw,
        masked: spec.secret ? mask(raw) : '',
      })
    }
    return out
  }

  async save(values: Record<string, unknown>): Promise<{ changed: string[]; restartRequired: true }> {
    const changed: string[] = []
    for (const [key, raw] of Object.entries(values)) {
      if (!SETTING_KEY_SET.has(key)) continue
      if (typeof raw !== 'string') continue
      const value = raw.trim()
      if (!value) {
        await this.rows.delete(key).catch(() => undefined)
        const fallback = this.envDefaults[key]
        if (fallback === undefined) delete process.env[key]
        else process.env[key] = fallback
        changed.push(key)
        continue
      }
      const secret = SETTING_KEYS.find((item) => item.key === key)?.secret ?? false
      const row: Omit<SettingRow, 'id'> = {
        value: secret ? encryptSecret(value) : value,
        secret,
        updated_at: Date.now(),
      }
      const existing = await this.rows.get(key).catch(() => null)
      if (existing) await this.rows.update(key, row)
      else await this.rows.insert({ id: key, ...row })
      process.env[key] = value
      changed.push(key)
    }
    return { changed, restartRequired: true }
  }
}

export function apply(ctx: Context): void {
  const store = ctx.store
  const gateway = ctx.gateway
  const service = new SettingsService(ctx, store.collection<SettingRow>('qm_setting'))
  void service

  ctx.effect(() =>
    gateway.route({
      method: 'GET',
      path: '/api/v1/settings',
      async handler(_req: GatewayRequest, res: GatewayResponse) {
        res.status(200).send({ ok: true, items: await service.list() })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'PUT',
      path: '/api/v1/settings',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const values = (body.values ?? {}) as Record<string, unknown>
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
          res.status(400).send({ ok: false, error: 'values 必须是对象' })
          return
        }
        const result = await service.save(values)
        res.status(200).send({ ok: true, ...result })
      },
    }),
  )

  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/settings/test',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        const kind = body.kind === 'embedding' ? 'embedding' : 'llm'
        const started = Date.now()
        try {
          if (kind === 'llm') {
            const base = (process.env.QM_LLM_BASE_URL ?? '').replace(/\/+$/, '')
            const key = process.env.QM_LLM_KEY ?? ''
            if (!base || !key) {
              res.status(400).send({ ok: false, error: '模型 Base URL 或 Key 未设置' })
              return
            }
            const response = await fetch(`${base}/models`, {
              headers: { Authorization: `Bearer ${key}` },
              signal: AbortSignal.timeout(8000),
            })
            res.status(response.ok ? 200 : 400).send({
              ok: response.ok,
              status: response.status,
              latencyMs: Date.now() - started,
              ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
            })
            return
          }
          const url = process.env.QM_EMBEDDING_URL ?? ''
          const key = process.env.QM_EMBEDDING_KEY ?? ''
          const model = process.env.QM_EMBEDDING_MODEL ?? 'embedding-3'
          if (!url || !key) {
            res.status(400).send({ ok: false, error: 'Embedding URL 或 Key 未设置' })
            return
          }
          const response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: ['ping'] }),
            signal: AbortSignal.timeout(8000),
          })
          res.status(response.ok ? 200 : 400).send({
            ok: response.ok,
            status: response.status,
            latencyMs: Date.now() - started,
            ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
          })
        } catch (error) {
          res.status(400).send({
            ok: false,
            latencyMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
  )
  ctx.effect(() =>
    gateway.route({
      method: 'POST',
      path: '/api/v1/settings/restart',
      async handler(req: GatewayRequest, res: GatewayResponse) {
        const body = (req.body ?? {}) as Record<string, unknown>
        if (body.confirm !== 'restart') {
          res.status(400).send({ ok: false, error: '需要 confirm: "restart"' })
          return
        }
        res.status(200).send({ ok: true, restarting: true })
        setTimeout(() => process.exit(0), 300)
      },
    }),
  )
}



