<script setup>
import { onMounted, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson } from '../lib/api.js'
import { formatWhen } from '../lib/format.js'

const items = ref([])
const conversationId = ref('')
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const body = await apiJson(ENDPOINTS.audit, {
      query: { limit: 50, conversationId: conversationId.value.trim() },
    })
    items.value = Array.isArray(body?.items) ? body.items : []
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '读取审计失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">审计</h2>
        <p class="view-sub">只追加的工具调用流水。被拒绝的调用也在这里——审计先写、再抛错。</p>
      </div>
      <div class="view-actions">
        <input v-model="conversationId" class="input narrow" placeholder="群/会话 id（可空）" @keydown.enter="load" />
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <p v-if="!loading && items.length === 0" class="empty">没有审计记录。</p>

    <ul class="list">
      <li v-for="item in items" :key="item.id" class="item">
        <div class="item-main">
          <p class="item-title">
            <span class="badge" :class="item.decision === 'deny' ? 'badge-failed' : 'badge-done'">{{ item.decision || '记录' }}</span>
            {{ item.action }}
          </p>
          <p class="item-meta">
            {{ item.actorId || '' }}
            <span v-if="item.conversationId"> · {{ item.conversationId }}</span>
            · {{ formatWhen(item.at, null) }}
          </p>
        </div>
      </li>
    </ul>
  </section>
</template>
