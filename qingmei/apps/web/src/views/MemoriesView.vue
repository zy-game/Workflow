<script setup>
import { onMounted, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'

const facts = ref([])
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const body = await apiJson(ENDPOINTS.memoryFacts)
    facts.value = Array.isArray(body?.facts) ? body.facts : []
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '读取记忆失败'
  } finally {
    loading.value = false
  }
}

async function edit(fact) {
  const next = window.prompt('修正这条记忆的内容', String(fact.object ?? ''))
  if (next === null) return
  const value = next.trim()
  if (!value) return
  try {
    await apiSend(`${ENDPOINTS.memoryFacts}/${encodeURIComponent(fact.id)}`, {
      method: 'PATCH',
      body: { object: value },
    })
    await load()
  } catch (err) {
    error.value = err.message || '修正失败'
  }
}

async function remove(fact) {
  if (!window.confirm(`删除「${fact.object}」？`)) return
  try {
    await apiSend(`${ENDPOINTS.memoryFacts}/${encodeURIComponent(fact.id)}`, { method: 'DELETE' })
    await load()
  } catch (err) {
    error.value = err.message || '删除失败'
  }
}

onMounted(load)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">记忆</h2>
        <p class="view-sub">她记住的事实。写错的地方可以修正或删除——删除只影响以后，不改历史对话。</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <p v-if="!loading && facts.length === 0" class="empty">还没有记住什么。聊几句，青梅会自己记。</p>

    <ul class="list">
      <li v-for="fact in facts" :key="fact.id" class="item">
        <div class="item-main">
          <p class="item-title">{{ fact.subject }} {{ fact.predicate }} {{ fact.object }}</p>
          <p class="item-meta">置信 {{ Math.round(Number(fact.confidence) * 100) }}%</p>
        </div>
        <div class="item-actions">
          <button class="btn small ghost" type="button" @click="edit(fact)">修正</button>
          <button class="btn small danger" type="button" @click="remove(fact)">删除</button>
        </div>
      </li>
    </ul>
  </section>
</template>
