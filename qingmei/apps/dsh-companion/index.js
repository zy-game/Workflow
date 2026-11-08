/**
 * DSH Host companion.
 *
 * Runs inside the DSH GUI Host (Cordis), claims Qingmei device tasks and
 * creates real GUI sessions through the host Agent/Workspace services.
 * No ACP child process and no MCP.
 */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'

export const name = 'qingmei-dsh-companion'
export const inject = ['agents', 'workspaceRegistry', 'agentDefaultModel', 'sessionController']

function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (value.content !== undefined) return textOf(value.content)
  return ''
}

export function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  if (!config.api || !config.token || !config.deviceId) {
    console.error('[qingmei-dsh] companion 缺少 api/token/deviceId，未启动')
    return
  }

  const api = String(config.api).replace(/\/+$/, '')
  const token = String(config.token)
  const deviceId = String(config.deviceId)
  const workspacePath = String(config.workspacePath || process.cwd())
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  const workspaces = () => {
    try {
      return ctx.workspaceRegistry.list().map((workspace) => ({
        id: String(workspace.id),
        title: String(workspace.title ?? workspace.path ?? ''),
        path: String(workspace.path ?? ''),
      })).filter((item) => item.id && item.path)
    } catch {
      return []
    }
  }
  const active = new Map()
  let running = false
  let stopped = false
  let registered = false

  const post = async (path, body) => {
    const res = await fetch(`${api}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
    return data
  }

  const register = async () => {
    if (registered) return
    await post('/api/v1/devices/register', {
      id: deviceId,
      name: `${process.env.COMPUTERNAME || 'DSH'} (DSH companion)`,
      platform: process.platform,
      arch: process.arch,
      hostname: process.env.COMPUTERNAME || '',
      harnesses: [{ kind: 'dsh', acp: true }],
      workspaces: workspaces(),
      workerVersion: 'dsh-companion/0.1.0',
    })
    registered = true
  }

  const claim = async () => {
    const result = await post('/api/v1/devices/claim', { deviceId, harness: 'dsh' })
    return result?.task ?? null
  }

  const contextFor = async (text, sessionId) => {
    try {
      const result = await post('/api/v1/devices/context', {
        deviceId,
        sessionId,
        text,
        limit: 5,
      })
      return typeof result?.text === 'string' ? result.text.trim() : ''
    } catch {
      return ''
    }
  }
  const report = async (taskId, body) => {
    await post('/api/v1/devices/progress', { taskId, ...body }).catch(() => undefined)
  }

  const finish = async (taskId, ok, result, error, sessionId) => {
    await post('/api/v1/devices/finish', {
      taskId,
      status: ok ? 'done' : 'failed',
      result: ok ? result : undefined,
      error: ok ? undefined : error,
      ...(sessionId ? { sessionId } : {}),
    }).catch((failure) => {
      console.error('[qingmei-dsh] finish 上报失败', failure)
    })
  }

  ctx.on('session/event', (session, event) => {
    const state = active.get(String(session?.id ?? ''))
    if (!state) return
    if (event.type === 'user/message') {
      const text = textOf(event.data)
      if (text) state.turns.push({ role: 'user', text: text.slice(0, 4000), at: event.time })
    } else if (event.type === 'assistant/message') {
      const data = event.data
      const text = textOf(data?.message?.content ?? data?.content ?? data)
      state.output += text
      if (text) state.turns.push({ role: 'assistant', text: text.slice(0, 8000), at: event.time })
    } else if (event.type === 'tool/result' || event.type === 'tool/call') {
      state.events.push({ type: event.type, at: event.time, data: event.data })
    }
  })

  const runTask = async (task) => {
    let sessionId
    let handle
    let state
    try {
      sessionId = String(task.sessionId || `session-${randomUUID()}`)
      const targetWorkspace = task.workspaceId
        ? workspaces().find((item) => item.id === task.workspaceId)
        : null
      if (task.workspaceId && !targetWorkspace) throw new Error('任务指定的工作区不在 DSH 中')
      const cwd = realpathSync(task.cwd || targetWorkspace?.path || workspacePath)
      const selection = ctx.agentDefaultModel?.currentSelection?.()
      let agent = null
      if (task.sessionId) {
        try {
          const resolved = await ctx.sessionController.resolveAgent(sessionId)
          agent = resolved?.agent ?? (resolved?.error ? null : resolved)
        } catch {
          agent = null
        }
      }
      if (!agent) {
        const created = await ctx.sessionController.create({
          sessionId,
          cwd,
          agentPreset: String(config.agentPreset || 'standard'),
        })
        sessionId = String(created?.sessionId ?? sessionId)
        agent = ctx.agents.get(sessionId)
      }
      if (selection) {
        await ctx.sessionController
          .selectModel?.({
            sessionId,
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          })
          .catch(() => undefined)
      }
      if (!agent) throw new Error('sessionController 创建后找不到 live agent')
      handle = { agent }
      const workspace = await ctx.workspaceRegistry.create(cwd)
      await workspace.attachSession(sessionId)
      state = { task, sessionId, output: '', turns: [], events: [] }
      active.set(sessionId, state)
      await report(task.id, { phase: 'running', percent: 10, note: 'dsh companion 已创建 GUI 会话' })

      const memory = await contextFor(String(task.prompt ?? ''), sessionId)
      const prompt = memory
        ? `【青梅记忆】\n${memory}\n\n【用户】\n${String(task.prompt ?? '')}`
        : String(task.prompt ?? '')
      handle.agent.followup({
        id: `msg-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })

      await handle.agent.whenIdle()
      const output = state.output.trim()
      await post('/api/v1/devices/ingest', {
        deviceId,
        sessionId,
        summary: output,
        turns: state.turns,
        events: state.events.slice(-100),
        facts: [],
        lessons: [],
      }).catch(() => undefined)
      if (!output) {
        await finish(task.id, false, undefined, 'DSH 会话没有返回 assistant 文本', sessionId)
        return
      }
      await report(task.id, { phase: 'finished', percent: 100, note: 'dsh companion 完成' })
      await finish(task.id, true, output, undefined, sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[qingmei-dsh] task failed', message)
      await finish(task.id, false, undefined, message, sessionId)
    } finally {
      if (sessionId) active.delete(sessionId)
      // 保留 agent/session，GUI 里仍可继续查看和接手；不 dispose。
      void handle
    }
  }

  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      await register()
      await post('/api/v1/devices/heartbeat', { id: deviceId, harnesses: [{ kind: 'dsh', acp: true }], workspaces: workspaces() }).catch(() => undefined)
      const task = await claim()
      if (task) await runTask(task)
    } catch (error) {
      console.error('[qingmei-dsh] poll failed', error instanceof Error ? error.message : String(error))
    } finally {
      running = false
    }
  }

  ctx.effect(() => {
    void tick()
    const timer = setInterval(() => void tick(), 3000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  })
}
