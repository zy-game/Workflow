<script setup>
import { onMounted, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson } from '../lib/api.js'
import { formatWhen } from '../lib/format.js'

const items = ref([])
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const body = await apiJson(ENDPOINTS.taskEventsAll, { query: { limit: 150 } })
    items.value = Array.isArray(body?.items) ? body.items : []
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '加载记录失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="view-inner">
    <header class="view-head">
      <div>
        <h2 class="view-title">记录</h2>
        <p class="view-sub">任务的创建、状态变化、决策都在这里；审计和任务共用一条事件流。</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <p v-if="!loading && items.length === 0" class="empty">还没有任务事件。</p>

    <ul class="list">
      <li v-for="event in items" :key="event.id" class="item">
        <div class="item-main">
          <p class="item-title">
            <span class="badge">{{ event.kind }}</span>
            {{ event.task_id }}
          </p>
          <p class="item-meta">
            {{ formatWhen(event.at) }}
            <span v-if="event.data?.status"> · {{ event.data.status }}</span>
            <span v-if="event.data?.kind"> · {{ event.data.kind }}</span>
          </p>
        </div>
      </li>
    </ul>
  </section>
</template>
