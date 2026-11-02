/**
 * @qingmei/provider-permission-static —— 静态策略的权限判定。
 *
 * 判定顺序（docs/02）：显式 deny > 显式 allow > 显式 ask > 会话类型默认 > 工具风险 > 全局默认。
 * 目前只接工具调用（`tool.invoke:<name>`）；群聊默认拒绝改日程与写记忆。
 * 拿到「需要确认」的判定时先把请求挡下来，渠道确认链路是 H 阶段的事（docs/07 §8）。
 */
import type { Context } from 'cordis'
import {
  PermissionService,
  type ChannelId,
  type Decision,
  type PermissionRequest,
  type PolicyRule,
} from '@qingmei/core'

export interface Config {
  /** 工具风险等级；未列出的工具按 defaultEffect 处理 */
  toolRisk?: Record<string, 'read' | 'write' | 'dangerous'>
  /** 群聊里按前缀拒绝的动作 */
  denyInGroup?: string[]
  /** 额外规则（与 addRule 的规则一起参与判定） */
  rules?: PolicyRule[]
  /** 没有任何规则命中时的默认判定。docs/02 约定全局默认是 deny */
  defaultEffect?: 'allow' | 'deny'
}

export const name = 'provider-permission-static'
export const inject: string[] = []

/** 当前 MCP 工具的风险分级。新增工具忘了登记时会被默认拒绝，这是有意的 */
const DEFAULT_TOOL_RISK: Record<string, 'read' | 'write' | 'dangerous'> = {
  memory_recall: 'read',
  schedule_list: 'read',
  memory_remember: 'write',
  schedule_create: 'write',
  schedule_update: 'write',
  schedule_cancel: 'write',
  schedule_pause: 'write',
  schedule_resume: 'write',
  // 任务数据面：派发 / 上报进度 / 交付产物 / 收尾
  qm_dispatch_task: 'write',
  qm_report_progress: 'write',
  qm_publish_artifact: 'write',
  qm_finish_task: 'write',
}

const DEFAULT_DENY_IN_GROUP = ['tool.invoke:schedule_', 'tool.invoke:memory_remember']

/** 群聊拒绝要给出人话，而不是「权限不足」 */
const GROUP_REASONS: { prefix: string; text: string }[] = [
  { prefix: 'tool.invoke:schedule_', text: '群聊里不能读或改你的日程' },
  { prefix: 'tool.invoke:memory_remember', text: '群聊里不能写入你的记忆' },
]

export class StaticPermission extends PermissionService {
  private readonly toolRisk: Record<string, 'read' | 'write' | 'dangerous'>
  private readonly denyInGroup: string[]
  private readonly defaultEffect: 'allow' | 'deny'
  private readonly builtIn: PolicyRule[]
  private readonly runtime: PolicyRule[] = []

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.toolRisk = { ...DEFAULT_TOOL_RISK, ...(config.toolRisk ?? {}) }
    this.denyInGroup = config.denyInGroup ?? DEFAULT_DENY_IN_GROUP
    this.defaultEffect = config.defaultEffect ?? 'deny'
    this.builtIn = [...(config.rules ?? [])]
  }

  async check(req: PermissionRequest): Promise<Decision> {
    const applicable = this.rules().filter((rule) => matches(rule, req))

    const denied = applicable.find((rule) => rule.effect === 'deny')
    if (denied) return { effect: 'deny', reason: denied.reason ?? `策略拒绝：${req.action}` }

    const allowed = applicable.find((rule) => rule.effect === 'allow')
    if (allowed) return { effect: 'allow' }

    const asked = applicable.find((rule) => rule.effect === 'ask')
    if (asked) return { effect: 'ask', prompt: asked.prompt ?? `执行前需要主人确认：${req.action}` }

    if (req.conversation === 'group') {
      const blocked = this.denyInGroup.find((prefix) => req.action.startsWith(prefix))
      if (blocked) return { effect: 'deny', reason: groupReason(blocked) }
    }

    const tool = toolNameOf(req.action)
    if (tool) {
      const risk = this.toolRisk[tool]
      if (risk === 'dangerous') {
        return { effect: 'ask', prompt: `执行 ${tool} 前需要主人确认` }
      }
      if (risk === 'read' || risk === 'write') return { effect: 'allow' }
    }

    if (this.defaultEffect === 'allow') return { effect: 'allow' }
    return { effect: 'deny', reason: `未配置策略，默认拒绝：${req.action}` }
  }

  rules(): PolicyRule[] {
    return [...this.builtIn, ...this.runtime]
  }

  addRule(rule: PolicyRule): () => void {
    this.runtime.push(rule)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      const index = this.runtime.indexOf(rule)
      if (index >= 0) this.runtime.splice(index, 1)
    }
  }
}

function matches(rule: PolicyRule, req: PermissionRequest): boolean {
  if (rule.conversation && rule.conversation !== req.conversation) return false
  if (rule.role && rule.role !== req.actor.role) return false
  return req.action.startsWith(rule.match)
}

function toolNameOf(action: string): string | null {
  const prefix = 'tool.invoke:'
  return action.startsWith(prefix) ? action.slice(prefix.length) : null
}

function groupReason(prefix: string): string {
  const hit = GROUP_REASONS.find((entry) => prefix.startsWith(entry.prefix))
  return hit?.text ?? '群聊里不能执行这个操作'
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(StaticPermission, config)
}

export const defaultExport = { name, inject, apply }
