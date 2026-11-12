#!/usr/bin/env node
/**
 * A2 自主动作的真实场景验证（会真的在目标环境建一个失败任务）。
 *
 * 验证的是「帮不帮倒忙」，不是「代码能不能跑」：
 *   1. 记下当前自主级别（结束时恢复，失败也恢复）；
 *   2. 建一个注定失败的任务（token 预算 1）；
 *   3. 手动 tick 一次：应在 A2 下直接重试，回执带 runId；
 *   4. 再 tick 一次：同一个失败任务不应再重试（防止重试风暴）；
 *   5. 回滚这次动作，恢复原级别。
 *
 * 用法：
 *   QM_URL=https://139.155.78.241:8710 QM_TOKEN=... node scripts/verify-a2.mjs
 *   QM_URL=http://127.0.0.1:7410 QM_TOKEN=dev-token node scripts/verify-a2.mjs --budget 1
 */
const BASE = String(process.env.QM_URL ?? 'http://127.0.0.1:7410').replace(/\/+$/, '')
const TOKEN = String(process.env.QM_TOKEN ?? '')
const args = process.argv.slice(2)
const budget = Number(args[args.indexOf('--budget') + 1]) || 1
const waitMs = Number(args[args.indexOf('--wait') + 1]) || 120_000

if (!TOKEN) {
  console.error('缺少 QM_TOKEN')
  process.exit(2)
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 200)}`)
  return json
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const before = await call('GET', '/api/v1/autonomy')
  const pending = await call('GET', '/api/v1/approvals?status=pending')
  if ((pending.items ?? []).length > 0) {
    throw new Error(`有 ${pending.items.length} 条待审批，先处理掉再跑（否则 tick 会先选审批）`)
  }

  const report = { before: { mode: before.mode, used: before.budget?.used, limit: before.budget?.limit }, steps: [] }
  let modeChanged = false
  let trace = null
  try {
    if (Number(before.budget?.used ?? 0) >= Number(before.budget?.limit ?? 3)) {
      throw new Error('今天的打扰预算已用完，tick 不会执行动作；明天再跑或临时提高 dailyBudget')
    }
    await call('POST', '/api/v1/autonomy/trust', { level: 'A2' })
    modeChanged = true
    report.steps.push({ step: 'set-A2', ok: true })

    // 用「前置任务不存在」制造确定的失败：不依赖模型、不烧 token，也不会真的执行
    const created = await call('POST', '/api/v1/tasks', {
      prompt: '只回复两个字：收到',
      title: 'A2 验证：前置任务不存在',
      dependsOn: [`run_missing_${Date.now().toString(36)}`],
      ...(budget > 0 ? { contract: { tokenBudget: budget } } : {}),
    })
    const runId = created?.run?.id
    report.steps.push({ step: 'create-task', runId })

    const deadline = Date.now() + waitMs
    let run = null
    while (Date.now() < deadline) {
      run = (await call('GET', `/api/v1/tasks?id=${encodeURIComponent(runId)}`)).run
      if (run && ['failed', 'done', 'cancelled'].includes(run.status)) break
      await sleep(2_000)
    }
    report.steps.push({ step: 'task-finished', status: run?.status, error: run?.error ?? null })
    if (run?.status !== 'failed') throw new Error(`预期任务失败，实际 ${run?.status}`)

    trace = await call('POST', '/api/v1/autonomy/tick')
    const exec = trace?.trace?.execution
    report.steps.push({ step: 'tick-1', chosen: trace?.trace?.chosen?.action, execution: exec?.status, detail: exec?.detail, runId: exec?.runId })
    if (exec?.action !== 'task.retry' || exec?.status !== 'executed') {
      throw new Error(`预期 A2 直接重试，实际 ${exec?.action}/${exec?.status}：${exec?.detail ?? ''}`)
    }

    const retried = (await call('GET', `/api/v1/tasks?id=${encodeURIComponent(exec.runId)}`)).run
    report.steps.push({ step: 'retried-task', target: retried?.target?.executorId, status: retried?.status })

    const second = await call('POST', '/api/v1/autonomy/tick')
    const exec2 = second?.trace?.execution
    report.steps.push({ step: 'tick-2', action: exec2?.action, execution: exec2?.status, detail: exec2?.detail })
    // 第二次 tick 可能执行别的动作（比如概念提案通知）；只有「又重试了一次」才算风暴
    if (exec2?.action === 'task.retry' && exec2?.status === 'executed') {
      throw new Error('同一个失败任务被重复重试了：重试风暴')
    }

    const rollback = await call('POST', '/api/v1/autonomy/rollback', {
      traceId: trace?.trace?.id,
      reason: 'A2 验证后回滚',
    })
    report.steps.push({ step: 'rollback', ok: rollback?.ok, detail: rollback?.detail ?? rollback?.error ?? null })
  } finally {
    if (modeChanged) {
      const restored = before.mode === 'locked' ? 'A1' : before.mode
      await call('POST', '/api/v1/autonomy/trust', { level: restored }).catch((error) => {
        console.error(`恢复自主级别失败，请手动设为 ${before.mode}：${error.message}`)
      })
      report.restoredTo = restored
    }
  }
  console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => {
  console.error(`[verify-a2] ${error.message}`)
  process.exitCode = 1
})
