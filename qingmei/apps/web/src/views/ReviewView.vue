<script setup>
import { onMounted, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'

const report = ref(null)
const cards = ref([])
const proposals = ref([])
const scoreInput = ref('')
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const body = await apiJson(ENDPOINTS.review)
    report.value = Array.isArray(body?.items) ? body.items[0] ?? null : null
    scoreInput.value = report.value?.score ?? ''
    await Promise.all([loadCards(), loadProposals()])
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '加载复盘失败'
  } finally {
    loading.value = false
  }
}

async function loadCards() {
  try {
    const body = await apiJson(ENDPOINTS.reviewCards)
    cards.value = Array.isArray(body?.items) ? body.items.slice(0, 20) : []
  } catch {
    // 评分卡是可选增强，失败不挡复盘正文
  }
}

async function loadProposals() {
  try {
    const body = await apiJson(ENDPOINTS.reviewProposals)
    proposals.value = Array.isArray(body?.items) ? body.items : []
  } catch {
    // 提案加载失败不阻塞复盘正文
  }
}

async function runReview() {
  try {
    const body = await apiSend(ENDPOINTS.reviewRun)
    report.value = body?.review ?? null
    scoreInput.value = report.value?.score ?? ''
    await Promise.all([loadCards(), loadProposals()])
  } catch (err) {
    error.value = err.message || '生成失败'
  }
}

async function submitScore() {
  const score = Number(scoreInput.value)
  if (!report.value?.id) return
  if (!Number.isFinite(score) || score < 1 || score > 10) {
    error.value = '评分需在 1..10'
    return
  }
  try {
    await apiSend(ENDPOINTS.reviewScore, { body: { id: report.value.id, score } })
    await load()
  } catch (err) {
    error.value = err.message || '提交失败'
  }
}

async function scoreCard(card, score) {
  try {
    await apiSend(ENDPOINTS.reviewCardScore, { body: { id: card.id, score } })
    await loadCards()
  } catch (err) {
    error.value = err.message || '评分失败'
  }
}

async function applyProposal(proposal) {
  if (!window.confirm('应用后人格提示词会立即更新，可在设置里回滚。继续？')) return
  try {
    await apiSend(ENDPOINTS.reviewProposalApply, { body: { id: proposal.id } })
    await loadProposals()
  } catch (err) {
    error.value = err.message || '应用失败'
  }
}

async function dismissProposal(proposal) {
  try {
    await apiSend(ENDPOINTS.reviewProposalDismiss, { body: { id: proposal.id } })
    await loadProposals()
  } catch (err) {
    error.value = err.message || '忽略失败'
  }
}

onMounted(load)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">复盘</h2>
        <p class="view-sub">每月 1 号自动生成；也可以现在生成本月。低分会在下月触发低分提醒。</p>
      </div>
      <div class="view-actions">
        <button class="btn small" type="button" @click="runReview">生成本月</button>
        <button class="btn small ghost" type="button" :disabled="loading" @click="load">刷新</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <p v-if="!report" class="empty">还没有复盘报告。下月 1 号会自动生成。</p>

    <template v-else>
      <pre class="markdown">{{ report.markdown || '' }}</pre>
      <div class="card">
        <h3 class="card-title">本月评分</h3>
        <p v-if="report.score" class="item-note">已记录 {{ report.score }}/10</p>
        <div class="field-row">
          <label class="field">
            <span class="field-label">评分（1..10）</span>
            <input v-model="scoreInput" class="input" type="number" min="1" max="10" />
          </label>
          <button class="btn" type="button" @click="submitScore">提交评分</button>
        </div>
      </div>
    </template>

    <div v-if="cards.length > 0" class="card">
      <h3 class="card-title">对话评分卡</h3>
      <div v-for="card in cards" :key="card.id" class="item">
        <div class="item-main">
          <p class="item-title">{{ card.role === 'user' ? '你' : '青梅' }}：{{ card.text }}</p>
        </div>
        <div class="item-actions">
          <button class="btn small ghost" type="button" :disabled="card.score !== null" @click="scoreCard(card, 8)">
            👍 好{{ card.score === null ? '' : `（已评 ${card.score}）` }}
          </button>
          <button class="btn small ghost" type="button" :disabled="card.score !== null" @click="scoreCard(card, 3)">
            👎 差{{ card.score === null ? '' : `（已评 ${card.score}）` }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="proposals.length > 0" class="card">
      <h3 class="card-title">改进提案</h3>
      <div v-for="proposal in proposals" :key="proposal.id" class="item">
        <div class="item-main">
          <p class="item-title">{{ proposal.kind === 'prompt' ? '提示词提案' : '改进建议' }} · {{ proposal.month }}</p>
          <p class="item-meta">{{ proposal.suggestion }}</p>
          <pre v-if="proposal.kind === 'prompt' && proposal.prompt" class="markdown small">{{ proposal.prompt }}</pre>
        </div>
        <div class="item-actions">
          <button v-if="proposal.kind === 'prompt'" class="btn small" type="button" @click="applyProposal(proposal)">应用提示词</button>
          <button class="btn small ghost" type="button" @click="dismissProposal(proposal)">忽略</button>
        </div>
      </div>
    </div>
  </section>
</template>
