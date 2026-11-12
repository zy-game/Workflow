<script setup>
import { onMounted, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'

const summary = ref(null)
const items = ref([])
const error = ref('')
const loading = ref(false)
const refreshing = ref(false)

async function load() {
  loading.value = true
  try {
    const body = await apiJson(ENDPOINTS.cost)
    summary.value = body
    items.value = Array.isArray(body?.items) ? body.items : []
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '加载用量失败'
  } finally {
    loading.value = false
  }
}

async function refreshBalance() {
  refreshing.value = true
  try {
    await apiSend(ENDPOINTS.costRefresh, { method: 'POST' })
    await load()
  } catch (err) {
    error.value = err.message || '刷新余额失败（检查 DeepSeek key）'
  } finally {
    refreshing.value = false
  }
}

function money(value) {
  if (value === null || value === undefined) return '—'
  return `${Number(value).toFixed(2)}`
}

onMounted(load)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">用量</h2>
        <p class="view-sub">余额来自 DeepSeek 官方接口（只读），今日花费按余额差估算；embedding 用量是实际 token 记账。</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :disabled="refreshing" @click="refreshBalance">
          {{ refreshing ? '取余额中…' : '刷新余额' }}
        </button>
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>

    <div v-if="summary" class="cards">
      <article class="card">
        <p class="card-label">余额</p>
        <p class="card-value">{{ money(summary.balance) }} {{ summary.currency }}</p>
        <p class="card-hint">{{ summary.day }}</p>
      </article>
      <article class="card">
        <p class="card-label">今日花费</p>
        <p class="card-value">{{ money(summary.spentSinceYesterday) }} {{ summary.currency }}</p>
        <p class="card-hint">较昨日余额差</p>
      </article>
      <article class="card">
        <p class="card-label">embedding 今日</p>
        <p class="card-value">{{ summary.embeddingTodayTokens ?? 0 }} tokens</p>
        <p class="card-hint">{{ summary.embeddingTodayCalls ?? 0 }} 次调用</p>
      </article>
      <article class="card">
        <p class="card-label">embedding 本月</p>
        <p class="card-value">{{ summary.embeddingMonthTokens ?? 0 }} tokens</p>
        <p class="card-hint">智谱 embedding-3</p>
      </article>
    </div>

    <p v-if="!loading && items.length === 0" class="empty">还没有余额快照。每天 06:00 会自动取一次，也可以点「刷新余额」。</p>

    <ul class="list">
      <li v-for="item in items" :key="item.id" class="item">
        <div class="item-main">
          <p class="item-title">{{ item.day }}</p>
          <p class="item-meta">余额 {{ money(item.total) }} {{ item.currency }} · 赠金 {{ money(item.granted) }} · 充值 {{ money(item.toppedUp) }}</p>
        </div>
      </li>
    </ul>
  </section>
</template>
