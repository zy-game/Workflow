<script setup>
import { onMounted, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'
import { formatWhen } from '../lib/format.js'

const version = ref('')
const prompt = ref('')
const history = ref([])
const skillName = ref('')
const skillHistory = ref([])
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const [personaBody, historyBody] = await Promise.all([
      apiJson(ENDPOINTS.persona),
      apiJson(ENDPOINTS.personaHistory),
    ])
    version.value = `当前 ${personaBody?.persona?.version ?? '?'} · ${personaBody?.persona?.hash ?? ''}`
    prompt.value = personaBody?.persona?.prompt ?? ''
    history.value = Array.isArray(historyBody?.items) ? historyBody.items.slice(0, 12) : []
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '加载设置失败'
  } finally {
    loading.value = false
  }
}

async function applyPersona() {
  const next = prompt.value.trim()
  if (!next) {
    error.value = '提示词不能为空'
    return
  }
  try {
    await apiSend(ENDPOINTS.personaApply, { body: { prompt: next, note: 'Web 设置页' } })
    await load()
  } catch (err) {
    error.value = err.message || '应用失败'
  }
}

async function rollbackPersona(entry) {
  try {
    await apiSend(ENDPOINTS.personaRollback, { body: { id: entry.id } })
    await load()
  } catch (err) {
    error.value = err.message || '回滚失败'
  }
}

async function loadSkillHistory() {
  const name = skillName.value.trim()
  if (!name) {
    error.value = '先填技能名'
    return
  }
  try {
    const body = await apiJson(ENDPOINTS.skillsHistory, { query: { name } })
    skillHistory.value = Array.isArray(body?.items) ? body.items : []
    error.value = ''
  } catch (err) {
    error.value = err.message || '读取技能历史失败'
  }
}

async function rollbackSkill(entry) {
  try {
    await apiSend(ENDPOINTS.skillsRollback, { body: { name: skillName.value.trim(), id: entry.id } })
    await loadSkillHistory()
  } catch (err) {
    error.value = err.message || '技能回滚失败'
  }
}

onMounted(load)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">设置</h2>
        <p class="view-sub">人格与技能都有版本快照，改坏了可以回滚。她写、她改；人只有 revert / tag / freeze。</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>

    <div class="card">
      <h3 class="card-title">人格提示词</h3>
      <p class="item-meta">{{ version }}</p>
      <textarea v-model="prompt" class="textarea" rows="8"></textarea>
      <div class="item-actions">
        <button class="btn" type="button" @click="applyPersona">应用并快照</button>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">人格历史</h3>
      <ul class="sublist">
        <li v-for="entry in history" :key="entry.id" class="item">
          <div class="item-main">
            <p class="item-title">{{ entry.version }} · {{ entry.kind }}</p>
            <p class="item-meta">{{ formatWhen(entry.createdAt, null) }} · {{ entry.note || entry.hash }}</p>
          </div>
          <div class="item-actions">
            <button class="btn small ghost" type="button" @click="rollbackPersona(entry)">回滚</button>
          </div>
        </li>
      </ul>
    </div>

    <div class="card">
      <h3 class="card-title">技能版本</h3>
      <div class="field-row">
        <label class="field">
          <span class="field-label">技能名</span>
          <input v-model="skillName" class="input" @keydown.enter="loadSkillHistory" />
        </label>
        <button class="btn ghost" type="button" @click="loadSkillHistory">查看历史</button>
      </div>
      <ul class="sublist">
        <li v-for="entry in skillHistory" :key="entry.id" class="item">
          <div class="item-main">
            <p class="item-title">{{ entry.id }}</p>
            <p class="item-meta">{{ formatWhen(entry.at, null) }}</p>
          </div>
          <div class="item-actions">
            <button class="btn small ghost" type="button" @click="rollbackSkill(entry)">回滚</button>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>
