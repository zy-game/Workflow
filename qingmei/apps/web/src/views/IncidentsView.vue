<script setup>
import { onMounted, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'
import { formatWhen, INCIDENT_STATUS_TEXT } from '../lib/format.js'

const items = ref([])
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const body = await apiJson(ENDPOINTS.incidents)
    items.value = Array.isArray(body?.items) ? body.items : []
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '加载故障失败'
  } finally {
    loading.value = false
  }
}

async function act(endpoint, incident) {
  try {
    await apiSend(endpoint, { body: { id: incident.id } })
    await load()
  } catch (err) {
    error.value = err.message || '操作失败'
  }
}

onMounted(load)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">故障</h2>
        <p class="view-sub">回合或任务失败时按指纹去重记在这里；可派诊断、回滚或标记解决。</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <p v-if="!loading && items.length === 0" class="empty">还没有故障记录。回合或任务失败时会自动记在这里。</p>

    <ul class="list">
      <li v-for="item in items" :key="item.id" class="item">
        <div class="item-main">
          <p class="item-title">
            <span class="badge" :class="item.status === 'resolved' ? 'badge-done' : 'badge-running'">
              {{ INCIDENT_STATUS_TEXT[item.status] ?? item.status }}
            </span>
            {{ item.fingerprint }}
          </p>
          <p class="item-meta">
            {{ String(item.message).slice(0, 120) }} · 出现 {{ item.count }} 次 · {{ formatWhen(item.lastAt, null) }}
          </p>
        </div>
        <div class="item-actions">
          <button
            v-if="['proposed', 'open', 'fused'].includes(item.status)"
            class="btn small ghost"
            type="button"
            @click="act(ENDPOINTS.incidentDispatch, item)"
          >
            派诊断
          </button>
          <button v-if="item.runId" class="btn small ghost" type="button" @click="act(ENDPOINTS.incidentRollback, item)">
            回滚任务
          </button>
          <button v-if="item.status !== 'resolved'" class="btn small" type="button" @click="act(ENDPOINTS.incidentResolve, item)">
            解决
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
