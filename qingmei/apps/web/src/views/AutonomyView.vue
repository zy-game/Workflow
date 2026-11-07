<script setup>
import { computed, onMounted, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'
import { AUTONOMY_EXEC_TEXT, formatWhen } from '../lib/format.js'

const traces = ref([])
const budget = ref({ used: 0, limit: 0 })
const trust = ref({ accepted: 0, ignored: 0, streak: 0 })
const mode = ref('A1')
const locked = ref(false)
const digestCount = ref(0)
const error = ref('')
const loading = ref(false)
const ticking = ref(false)

const budgetLine = computed(() => {
  const complaints = Number(trust.value.complaints) > 0 ? ` · 投诉 ${trust.value.complaints}` : ''
  const digest = digestCount.value > 0 ? ` · 摘要 ${digestCount.value} 条` : ''
  return `模式 ${mode.value} · 今日建议 ${budget.value.used}/${budget.value.limit} · 采纳 ${trust.value.accepted} · 忽略 ${trust.value.ignored} · 连续 ${trust.value.streak}${complaints}${digest}`
})

async function load() {
  loading.value = true
  try {
    const body = await apiJson(ENDPOINTS.autonomy)
    traces.value = Array.isArray(body?.items) ? body.items : []
    budget.value = body?.budget ?? { used: 0, limit: 0 }
    trust.value = body?.trust ?? { accepted: 0, ignored: 0, streak: 0 }
    mode.value = body?.mode ?? 'A1'
    locked.value = Boolean(body?.locked)
    digestCount.value = Number(body?.digest?.count) || 0
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '读取主动建议失败'
  } finally {
    loading.value = false
  }
}

async function setTrust(payload) {
  try {
    await apiSend(ENDPOINTS.autonomyTrust, { body: payload })
    await load()
  } catch (err) {
    error.value = err.message || '设置失败'
  }
}

async function tick() {
  ticking.value = true
  try {
    await apiSend(ENDPOINTS.autonomyTick)
    await load()
  } catch (err) {
    error.value = err.message || '巡视失败'
  } finally {
    ticking.value = false
  }
}

async function digest() {
  try {
    await apiSend(ENDPOINTS.autonomyDigest)
    await load()
  } catch (err) {
    error.value = err.message || '发摘要失败'
  }
}

async function complain() {
  try {
    await apiSend(ENDPOINTS.autonomyComplaint, { body: { reason: 'Web 面板投诉最近一条建议' } })
    await load()
  } catch (err) {
    error.value = err.message || '投诉失败'
  }
}

async function rollback() {
  try {
    await apiSend(ENDPOINTS.autonomyRollback, { body: { reason: 'Web 面板回滚最近动作' } })
    await load()
  } catch (err) {
    error.value = err.message || '回滚失败'
  }
}

onMounted(load)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">主动</h2>
        <p class="view-sub">自主循环每 5 分钟看一次世界状态，值得打扰时才给建议。人只在出事故时拦。</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost small" type="button" @click="complain" title="最近一条建议没用，降一级">这条没用</button>
        <button class="btn ghost small" type="button" @click="rollback" title="撤回最近一次已执行动作">回滚动作</button>
        <button class="btn ghost small" type="button" :disabled="digestCount === 0" @click="digest">发摘要</button>
        <button class="btn ghost small" type="button" :disabled="ticking" @click="tick">{{ ticking ? '巡视中…' : '立即巡一次' }}</button>
        <button class="btn ghost small" type="button" :disabled="loading" @click="load">刷新</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>

    <div class="card">
      <p class="budget-line">{{ budgetLine }}</p>
      <div class="segmented" role="group" aria-label="主动级别">
        <button
          v-for="level in ['A0', 'A1', 'A2']"
          :key="level"
          class="btn small ghost"
          type="button"
          :aria-pressed="mode === level"
          :class="{ active: mode === level }"
          @click="setTrust({ level })"
        >
          {{ level }}{{ level === 'A0' ? ' 观察' : level === 'A1' ? ' 建议' : ' 代理' }}
        </button>
        <button class="btn small ghost" type="button" :aria-pressed="locked" :class="{ active: locked }" @click="setTrust({ locked: !locked })">
          {{ locked ? '已锁死级别' : '锁死级别' }}
        </button>
      </div>
    </div>

    <p v-if="!loading && traces.length === 0" class="empty">
      还没有决策记录。自主循环每 5 分钟看一次世界状态，值得打扰时才给建议。
    </p>

    <ul class="list">
      <li v-for="trace in traces" :key="trace.id || trace.at" class="item">
        <div class="item-main">
          <p class="item-title">{{ formatWhen(trace.at, null) }} · {{ trace.chosen ? `建议：${trace.chosen.title}` : '保持沉默' }}</p>
          <p class="item-meta">{{ trace.reason || '' }}</p>
          <p class="item-note">
            <span v-if="trace.chosen">动作 {{ trace.chosen.action }}（{{ trace.chosen.risk }} 风险）</span>
            <span v-if="trace.candidates?.length"> · 候选 {{ trace.candidates.map((item) => item.id).join('、') }}</span>
            <span v-if="trace.suppressed?.length"> · 压制 {{ trace.suppressed.map((item) => `${item.id}：${item.reason}`).join('；') }}</span>
            <span v-if="trace.execution"> · 回执 {{ AUTONOMY_EXEC_TEXT[trace.execution.status] ?? trace.execution.status }}：{{ trace.execution.detail }}</span>
            <span> · 预算 {{ trace.budget?.used ?? 0 }}/{{ trace.budget?.limit ?? 0 }}</span>
          </p>
        </div>
      </li>
    </ul>
  </section>
</template>
